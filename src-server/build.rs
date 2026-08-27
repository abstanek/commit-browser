use std::path::Path;

// The frontend is compiled into the binary from dist-web/, which npm writes and
// git ignores. Create it when absent so a checkout without a built frontend
// still compiles; the server warns at startup when it has nothing to serve.
fn main() {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist-web");
    if !dist.exists() {
        std::fs::create_dir_all(&dist).expect("create dist-web");
    }
    // include_dir! does not tell cargo what it read, so name the directory here.
    println!("cargo:rerun-if-changed=../dist-web");
}
