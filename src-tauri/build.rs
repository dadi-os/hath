fn main() {
    let target = std::env::var("TARGET").expect("TARGET");
    let ios = target.contains("apple-ios");
    let desktop_apple = target.contains("apple-darwin");
    let windows = target.contains("windows");
    let linux = target.contains("linux");

    // Desktop uses system tailscaled (sysmesh). iOS keeps in-process libhathnet.
    if ios {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("lib")
            .join("ios-arm64");
        if !path.join("libhathnet.a").exists() {
            panic!(
                "missing {}/libhathnet.a — run `cd net && ./build.sh ios-arm64` first",
                path.display()
            );
        }
        println!("cargo:rerun-if-changed={}", path.join("libhathnet.a").display());
        println!("cargo:rustc-link-search=native={}", path.display());
        println!("cargo:rustc-link-lib=static=hathnet");
    }

    if desktop_apple || linux || windows {
        let bin_dir = if desktop_apple {
            if target.starts_with("x86_64-") {
                "darwin-amd64"
            } else {
                "darwin-arm64"
            }
        } else if linux {
            "linux-amd64"
        } else {
            "windows-amd64"
        };
        let bin_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join(bin_dir);
        let ts = if windows {
            bin_path.join("tailscale.exe")
        } else {
            bin_path.join("tailscale")
        };
        let tsd = if windows {
            bin_path.join("tailscaled.exe")
        } else {
            bin_path.join("tailscaled")
        };
        if !ts.exists() || !tsd.exists() {
            panic!(
                "missing {} — run `cd net && ./build-tailscale.sh {bin_dir}` first",
                bin_path.display()
            );
        }
        println!("cargo:rerun-if-changed={}", ts.display());
        println!("cargo:rerun-if-changed={}", tsd.display());
        if windows {
            let wintun = bin_path.join("wintun.dll");
            if !wintun.exists() {
                panic!(
                    "missing {} — run `cd net && ./build-tailscale.sh windows-amd64` (fetches Wintun)",
                    wintun.display()
                );
            }
            println!("cargo:rerun-if-changed={}", wintun.display());
        }
    }

    if target.contains("apple") {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=IOKit");
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
    }

    // Network Extension bridge (iOS + macOS). Real ObjC is linked from Xcode;
    // cargo builds use the C stub until the extension target is wired.
    if ios || desktop_apple {
        println!("cargo:rustc-link-lib=framework=NetworkExtension");
        let stub = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("dadimesh-extension")
            .join("dadimesh_vpn_stub.c");
        println!("cargo:rerun-if-changed={}", stub.display());
        cc::Build::new().file(&stub).compile("dadimesh_vpn_stub");
    }

    tauri_build::build()
}
