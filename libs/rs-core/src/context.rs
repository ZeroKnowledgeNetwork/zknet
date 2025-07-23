use crate::{
    config::{load_config, AppConfig},
    paths::AppPaths,
};

pub struct AppContext {
    pub config: AppConfig,
    pub paths: AppPaths,
    pub platform_arch: String,
}

impl AppContext {
    pub fn new(app_name: &str, config_json: &str, platform_arch: String) -> Self {
        let paths = AppPaths::new(app_name);
        let config = load_config(&paths, config_json);
        Self {
            config,
            paths,
            platform_arch,
        }
    }
}
