#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::path::Path;

#[tauri::command]
fn write_project(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let destination = Path::new(&path);
    let parent = destination.parent().ok_or("Invalid project file path")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary.write_all(&bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(destination).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![write_project])
        .run(tauri::generate_context!())
        .expect("Could not start Project Risk Planner");
}
