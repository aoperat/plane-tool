fn main() {
    // Bakes a default OpenAI key into the binary so colleagues installing the
    // app never have to type one in themselves. Set via env var (CI: the
    // OPENAI_API_KEY_DEFAULT repo secret in release.yml; local: set it in the
    // shell before `cargo build`/`tauri dev`) — never committed to git.
    println!("cargo:rerun-if-env-changed=OPENAI_API_KEY_DEFAULT");
    if let Ok(key) = std::env::var("OPENAI_API_KEY_DEFAULT") {
        println!("cargo:rustc-env=OPENAI_API_KEY_DEFAULT={key}");
    }

    let mut attributes = tauri_build::Attributes::new();
    // Release builds require elevation so global shortcuts keep working while
    // an elevated window has focus (UIPI blocks input to non-elevated apps).
    // Debug builds stay unelevated so `tauri dev` can spawn from a normal
    // terminal (CreateProcess cannot launch an exe that requires elevation).
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        attributes = attributes.windows_attributes(
            tauri_build::WindowsAttributes::new()
                .app_manifest(include_str!("windows-app.manifest")),
        );
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
