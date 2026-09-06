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
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	status    int // 0 disconnected, 1 connecting, 2 connected
	lastError string
)

//export hathnet_start
func hathnet_start(controlURL, authKey, hostname, stateDir *C.char) C.int {
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
		lastError = fmt.Sprintf("tsnet up: %v", err)
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
		Handler: proxyHandler(s),
		// No read/write timeouts — SSE /events must stay open indefinitely.
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

//export hathnet_stop
func hathnet_stop() {
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

//export hathnet_status
func hathnet_status() C.int {
	mu.Lock()
	defer mu.Unlock()
	return C.int(status)
}

//export hathnet_last_error
func hathnet_last_error() *C.char {
	mu.Lock()
	defer mu.Unlock()
	return C.CString(lastError)
}

//export hathnet_free
func hathnet_free(p *C.char) {
	C.free(unsafe.Pointer(p))
}

func hasPersistedIdentity(dir string) bool {
	// tsnet writes tailscaled.state once the node has joined.
	_, err := os.Stat(filepath.Join(dir, "tailscaled.state"))
	return err == nil
}

func proxyHandler(s *tsnet.Server) http.Handler {
	client := s.HTTPClient()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstream := r.Header.Get("X-Hath-Upstream")
		if upstream == "" {
			http.Error(w, "missing X-Hath-Upstream", http.StatusBadRequest)
			return
		}

		target := strings.TrimRight(upstream, "/") + r.URL.RequestURI()
		out, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}

		for name, values := range r.Header {
			if strings.EqualFold(name, "X-Hath-Upstream") || strings.EqualFold(name, "Host") {
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
				if err != io.EOF {
					return
				}
				return
			}
		}
	})
}

func main() {}
