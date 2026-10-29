use crate::{
    config::{load_config, AppConfig},
    network::Platform,
    paths::AppPaths,
};

pub struct AppContext {
    pub config: AppConfig,
    pub paths: AppPaths,
    pub platform: Platform,
}

impl AppContext {
    pub fn new(app_name: &str, config_json: &str, platform: Platform) -> Self {
        let paths = AppPaths::new(app_name);
        let config = load_config(&paths, config_json);
        Self {
            config,
            paths,
            platform,
        }
    }
}
