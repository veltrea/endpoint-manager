use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use std::sync::Mutex;

struct SidecarChild(Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// Node.js の実行パスを検出する
fn find_node_path() -> Option<String> {
    // 1. 環境変数 EM_NODE_PATH
    if let Ok(p) = std::env::var("EM_NODE_PATH") {
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }

    // 2. nvm で管理された Node.js v22
    let home = std::env::var("HOME").unwrap_or_default();
    let nvm_path = format!("{}/.nvm/versions/node/v22.17.0/bin/node", home);
    if std::path::Path::new(&nvm_path).exists() {
        return Some(nvm_path);
    }

    // 3. Homebrew (Apple Silicon)
    let brew_path = "/opt/homebrew/bin/node";
    if std::path::Path::new(brew_path).exists() {
        return Some(brew_path.to_string());
    }

    // 4. Homebrew (Intel)
    let brew_intel = "/usr/local/bin/node";
    if std::path::Path::new(brew_intel).exists() {
        return Some(brew_intel.to_string());
    }

    None
}

/// プロジェクトルートを検出する（src/index.ts がある場所）
fn find_project_root() -> Option<std::path::PathBuf> {
    // 開発時: カレントディレクトリがプロジェクトルート
    let cwd = std::env::current_dir().ok()?;
    if cwd.join("src/index.ts").exists() {
        return Some(cwd);
    }

    // Tauri dev 時: src-tauri/ から実行されることがある
    let parent = cwd.parent()?;
    if parent.join("src/index.ts").exists() {
        return Some(parent.to_path_buf());
    }

    // バンドル時: exe の場所から逆算
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent()?.to_path_buf();
        for _ in 0..5 {
            if dir.join("src/index.ts").exists() {
                return Some(dir);
            }
            dir = dir.parent()?.to_path_buf();
        }
    }

    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let node_path = match find_node_path() {
                Some(p) => p,
                None => {
                    eprintln!("[backend] ERROR: Node.js not found. Install Node.js >= 22.");
                    return Ok(());
                }
            };

            let project_root = match find_project_root() {
                Some(p) => p,
                None => {
                    eprintln!("[backend] ERROR: Could not locate project root (src/index.ts).");
                    return Ok(());
                }
            };

            println!("[backend] node: {}", node_path);
            println!("[backend] project: {}", project_root.display());

            // Node.js バックエンドを起動
            let cmd = app.shell()
                .command(&node_path)
                .args(["--import", "tsx/esm", "src/index.ts"])
                .current_dir(project_root);

            let (mut rx, child) = match cmd.spawn() {
                Ok(result) => result,
                Err(e) => {
                    eprintln!("[backend] failed to spawn Node.js backend: {}", e);
                    return Ok(());
                }
            };

            app.manage(SidecarChild(Mutex::new(Some(child))));

            // stdout/stderr をフォワード
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line);
                            println!("[backend] {}", text);
                        }
                        CommandEvent::Stderr(line) => {
                            let text = String::from_utf8_lossy(&line);
                            eprintln!("[backend:err] {}", text);
                        }
                        CommandEvent::Terminated(status) => {
                            eprintln!("[backend] terminated: {:?}", status);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<SidecarChild>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                            println!("[backend] process killed on window close");
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
