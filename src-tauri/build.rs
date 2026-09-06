fn main() {
    let target = std::env::var("TARGET").expect("TARGET");
    let dir = if target.contains("apple-darwin") {
        "darwin-arm64"
    } else if target.contains("apple-ios") {
        "ios-arm64"
    } else if target.contains("linux") {
        "linux-amd64"
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

    tauri_build::build()
}
