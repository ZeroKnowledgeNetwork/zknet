use crate::{
    config::{load_config, AppConfig},
    paths::AppPaths,
};

pub struct AppContext {
    pub config: AppConfig,
    pub paths: AppPaths,
}

impl AppContext {
    pub fn new(app_name: &str, config_json: &str) -> Self {
        let paths = AppPaths::new(app_name);
        let config = load_config(&paths, config_json);
        Self { config, paths }
    }
}
