package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"tailscale.com/tsnet"
)

const (
	statusDisconnected = 0
	statusConnecting   = 1
	statusConnected    = 2
)

var (
	mu        sync.Mutex
	srv       *tsnet.Server
	listener  net.Listener
	httpSrv   *http.Server
	proxyPort int
	status    int
	lastError string
)

//export dadimesh_start
func dadimesh_start(controlURL, authKey, hostname, stateDir *C.char) C.int {
	mu.Lock()
	defer mu.Unlock()

	if status == statusConnected && listener != nil {
		return C.int(proxyPort)
	}
	if status == statusConnecting {
		lastError = "already connecting"
		return -1
	}

	status = statusConnecting
	lastError = ""

	dir := C.GoString(stateDir)
	host := C.GoString(hostname)
	control := C.GoString(controlURL)
	key := C.GoString(authKey)

	if key == "" && !hasPersistedIdentity(dir) {
		status = statusDisconnected
		lastError = "auth key required"
		return -4
	}

	s := &tsnet.Server{
		Dir:        dir,
		Hostname:   host,
		ControlURL: control,
		AuthKey:    key,
		Ephemeral:  false,
	}

	ctx := context.Background()
	if _, err := s.Up(ctx); err != nil {
		_ = s.Close()
		status = statusDisconnected
		lastError = fmt.Sprintf("dadimesh up: %v", err)
		return -2
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = s.Close()
		status = statusDisconnected
		lastError = fmt.Sprintf("listen: %v", err)
		return -3
	}

	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		_ = ln.Close()
		_ = s.Close()
		status = statusDisconnected
		lastError = "listen: unexpected address type"
		return -3
	}

	hs := &http.Server{
		Handler:           meshProxyHandler(s),
		ReadHeaderTimeout: 30 * time.Second,
	}

	srv = s
	listener = ln
	httpSrv = hs
	proxyPort = addr.Port
	status = statusConnected

	go func() {
		if err := hs.Serve(ln); err != nil && err != http.ErrServerClosed {
			mu.Lock()
			lastError = fmt.Sprintf("proxy serve: %v", err)
			status = statusDisconnected
			mu.Unlock()
		}
	}()

	return C.int(proxyPort)
}

//export dadimesh_stop
func dadimesh_stop() {
	mu.Lock()
	defer mu.Unlock()
	stopLocked()
}

func stopLocked() {
	if httpSrv != nil {
		_ = httpSrv.Close()
		httpSrv = nil
	}
	if listener != nil {
		_ = listener.Close()
		listener = nil
	}
	if srv != nil {
		_ = srv.Close()
		srv = nil
	}
	proxyPort = 0
	status = statusDisconnected
}

//export dadimesh_status
func dadimesh_status() C.int {
	mu.Lock()
	defer mu.Unlock()
	return C.int(status)
}

//export dadimesh_port
func dadimesh_port() C.int {
	mu.Lock()
	defer mu.Unlock()
	return C.int(proxyPort)
}

//export dadimesh_last_error
func dadimesh_last_error() *C.char {
	mu.Lock()
	defer mu.Unlock()
	return C.CString(lastError)
}

//export dadimesh_free
func dadimesh_free(p *C.char) {
	C.free(unsafe.Pointer(p))
}

func hasPersistedIdentity(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "tailscaled.state"))
	return err == nil
}

// meshProxyHandler is an HTTP forward proxy over tsnet. Destinations are
// encoded in the path as /@host/rest (avoids forbidden Host overrides in
// webview fetch). CONNECT is supported for non-HTTP mesh dials.
func meshProxyHandler(s *tsnet.Server) http.Handler {
	client := s.HTTPClient()
	dial := s.Dial
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			handleConnect(w, r, dial)
			return
		}

		target, err := meshTargetURL(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		out, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		for name, values := range r.Header {
			if strings.EqualFold(name, "Proxy-Connection") {
				continue
			}
			for _, v := range values {
				out.Header.Add(name, v)
			}
		}

		resp, err := client.Do(out)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		for name, values := range resp.Header {
			for _, v := range values {
				w.Header().Add(name, v)
			}
		}
		w.WriteHeader(resp.StatusCode)

		flusher, _ := w.(http.Flusher)
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				if _, writeErr := w.Write(buf[:n]); writeErr != nil {
					return
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
			if err != nil {
				return
			}
		}
	})
}

// meshTargetURL maps /@dimaag.dadi/agents → http://dimaag.dadi/agents
// or absolute-form proxy URLs when present.
func meshTargetURL(r *http.Request) (string, error) {
	if r.URL.IsAbs() {
		return r.URL.String(), nil
	}
	path := r.URL.Path
	if strings.HasPrefix(path, "/@") {
		rest := strings.TrimPrefix(path, "/@")
		host, rem, ok := strings.Cut(rest, "/")
		if !ok {
			host = rest
			rem = ""
		}
		if host == "" {
			return "", fmt.Errorf("missing mesh host")
		}
		u := &url.URL{
			Scheme:   "http",
			Host:     host,
			Path:     "/" + rem,
			RawQuery: r.URL.RawQuery,
		}
		if rem == "" {
			u.Path = "/"
		}
		return u.String(), nil
	}
	host := r.Host
	if host == "" || strings.HasPrefix(host, "127.0.0.1") || strings.EqualFold(host, "localhost") {
		return "", fmt.Errorf("mesh path must be /@host/... or absolute URL")
	}
	u := &url.URL{
		Scheme:   "http",
		Host:     host,
		Path:     r.URL.Path,
		RawQuery: r.URL.RawQuery,
	}
	return u.String(), nil
}

func handleConnect(w http.ResponseWriter, r *http.Request, dial func(context.Context, string, string) (net.Conn, error)) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "CONNECT not supported", http.StatusInternalServerError)
		return
	}
	addr := r.Host
	if !strings.Contains(addr, ":") {
		addr += ":443"
	}
	backend, err := dial(r.Context(), "tcp", addr)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	clientConn, _, err := hj.Hijack()
	if err != nil {
		_ = backend.Close()
		return
	}
	_, _ = io.WriteString(clientConn, "HTTP/1.1 200 Connection Established\r\n\r\n")
	go proxyCopy(backend, clientConn)
	proxyCopy(clientConn, backend)
}

func proxyCopy(dst io.WriteCloser, src io.ReadCloser) {
	defer dst.Close()
	defer src.Close()
	_, _ = io.Copy(dst, src)
}

func main() {}
