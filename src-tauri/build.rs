fn main() {
    let target = std::env::var("TARGET").expect("TARGET");
    let dir = if target.contains("apple-darwin") {
        if target.starts_with("x86_64-") {
            "darwin-amd64"
        } else {
            "darwin-arm64"
        }
    } else if target.contains("apple-ios") {
        "ios-arm64"
    } else if target.contains("linux") {
        "linux-amd64"
    } else if target.contains("windows") {
        "windows-amd64"
    } else {
        panic!("unsupported target for hathnet: {target}");
    };

    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("lib")
        .join(dir);

    if target.contains("windows") {
        let dll = path.join("hathnet.dll");
        if !dll.exists() {
            panic!(
                "missing {} — run `cd net && ./build.sh windows-amd64` first",
                dll.display()
            );
        }
        println!("cargo:rerun-if-changed={}", dll.display());
        // Linkage is #[link(..., kind = "raw-dylib")] in net.rs — no import lib.
        // Ensure the DLL is beside the built binary for `tauri build` / local runs.
        let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());
        let out_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(&profile);
        let _ = std::fs::create_dir_all(&out_dir);
        let _ = std::fs::copy(&dll, out_dir.join("hathnet.dll"));
        // Cross-target builds land under target/<triple>/<profile>.
        if let Ok(target_triple) = std::env::var("TARGET") {
            let cross = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join(&target_triple)
                .join(&profile);
            let _ = std::fs::create_dir_all(&cross);
            let _ = std::fs::copy(&dll, cross.join("hathnet.dll"));
        }
    } else {
        if !path.join("libhathnet.a").exists() {
            panic!(
                "missing {}/libhathnet.a — run `cd net && ./build.sh` first",
                path.display()
            );
        }
        println!("cargo:rerun-if-changed={}", path.join("libhathnet.a").display());
        println!("cargo:rustc-link-search=native={}", path.display());
        println!("cargo:rustc-link-lib=static=hathnet");
    }

    if target.contains("apple") {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=IOKit");
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
    }

    if target.contains("apple-ios") {
        println!("cargo:rustc-link-lib=framework=NetworkExtension");
        let stub = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dadimesh-extension")
            .join("dadimesh_vpn_stub.c");
        println!("cargo:rerun-if-changed={}", stub.display());
        cc::Build::new().file(&stub).compile("dadimesh_vpn_stub");
    }

    tauri_build::build()
}
