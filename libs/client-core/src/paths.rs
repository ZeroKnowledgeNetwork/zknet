use std::{fs, path::PathBuf};

use directories_next::ProjectDirs;

const APP_ORGANIZATION: &str = "ZKNetwork";

pub struct AppPaths {
    project_dirs: ProjectDirs,
}

impl AppPaths {
    pub fn new(app_name: &str) -> Self {
        let project_dirs = ProjectDirs::from("com", APP_ORGANIZATION, app_name)
            .expect("Could not determine platform data dirs");

        // Ensure directory exists (create recursively)
        let data_dir = project_dirs.data_local_dir();
        fs::create_dir_all(data_dir)
            .unwrap_or_else(|e| panic!("Failed to create local data dir {:?}: {e}", data_dir));

        Self { project_dirs }
    }

    pub fn dir_data(&self) -> PathBuf {
        self.project_dirs.data_local_dir().to_path_buf()
    }

    pub fn dir_logs(&self) -> PathBuf {
        self.dir_data().join("logs")
    }

    pub fn path_settings(&self) -> PathBuf {
        self.dir_data().join("settings.json")
    }
}
