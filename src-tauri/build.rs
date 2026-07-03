fn main() {
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
