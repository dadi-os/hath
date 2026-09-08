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

    if !path.join("libhathnet.a").exists() {
        panic!(
            "missing {}/libhathnet.a — run `cd net && ./build.sh` first",
            path.display()
        );
    }

    println!("cargo:rerun-if-changed={}", path.join("libhathnet.a").display());
    println!("cargo:rustc-link-search=native={}", path.display());
    println!("cargo:rustc-link-lib=static=hathnet");

    if target.contains("apple") {
        println!("cargo:rustc-link-lib=framework=CoreFoundation");
        println!("cargo:rustc-link-lib=framework=Security");
        println!("cargo:rustc-link-lib=framework=IOKit");
        println!("cargo:rustc-link-lib=framework=SystemConfiguration");
    }

    // Go c-archive on Windows pulls these via MinGW; required when linking with
    // the x86_64-pc-windows-gnu Rust target.
    if target.contains("windows") {
        println!("cargo:rustc-link-lib=winmm");
        println!("cargo:rustc-link-lib=ntdll");
        println!("cargo:rustc-link-lib=ws2_32");
        println!("cargo:rustc-link-lib=userenv");
        println!("cargo:rustc-link-lib=iphlpapi");
        println!("cargo:rustc-link-lib=bcrypt");
    }

    tauri_build::build()
}
