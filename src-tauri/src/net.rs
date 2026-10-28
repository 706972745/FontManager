use crate::store::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

pub const USER_AGENT: &str = concat!(
    "ZFontManager/",
    env!("CARGO_PKG_VERSION"),
    " (+https://zsync.eu/zfontmanager/)"
);

pub const ALLOWED_HOSTS: [&str; 6] = [
    "api.fontsource.org",
    "raw.githubusercontent.com",
    "cdn.jsdelivr.net",
    "fastly.jsdelivr.net",
    "gcore.jsdelivr.net",
    "testingcf.jsdelivr.net",
];

const TIMEOUT: Duration = Duration::from_secs(60);

/// 原始地址单次尝试的超时：raw.githubusercontent.com 在一些网络下是直接丢包，
/// 等待太久会让「下载」看起来像卡死，所以先用短超时快速失败，再切换到镜像。
const RAW_TIMEOUT: Duration = Duration::from_secs(10);

pub fn client(state: &AppState) -> Result<reqwest::Client, String> {
    if !state.online_fonts_enabled {
        return Err("online fonts are switched off".to_string());
    }
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

pub fn check_host(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" {
        return Err(format!("refusing non-https url: {url}"));
    }
    match parsed.host_str() {
        Some(h) if ALLOWED_HOSTS.contains(&h) => Ok(()),
        Some(h) => Err(format!("host not allowed: {h}")),
        None => Err(format!("url has no host: {url}")),
    }
}

const RAW_PREFIX: &str = "https://raw.githubusercontent.com/google/fonts/main/";

/// raw.githubusercontent.com 的镜像（jsDelivr 的 GitHub 通道）。
/// 国内网络经常访问不了 raw.githubusercontent.com，但 jsDelivr 一般可用；
/// 节点之间可用性也会波动，所以准备多个，按顺序尝试。
const MIRROR_PREFIXES: [&str; 4] = [
    "https://cdn.jsdelivr.net/gh/google/fonts@main/",
    "https://fastly.jsdelivr.net/gh/google/fonts@main/",
    "https://gcore.jsdelivr.net/gh/google/fonts@main/",
    "https://testingcf.jsdelivr.net/gh/google/fonts@main/",
];

/// 记住「原始地址在本机不可达」，后续请求直接走镜像，避免每次都要等一轮超时。
static RAW_UNREACHABLE: AtomicBool = AtomicBool::new(false);

/// 这个标记的变化要落进 state.json：
/// 进程内记住只能管一次运行，重启后第一个在线请求又会先撞 10 秒超时（用户以为卡死）。
static PERSIST: OnceLock<Box<dyn Fn(bool) + Send + Sync>> = OnceLock::new();

/// 启动时把上次运行学到的结果灌进来，之后第一次在线请求就知道该不该直连。
pub fn seed_raw_unreachable(unreachable: bool) {
    RAW_UNREACHABLE.store(unreachable, Ordering::Relaxed);
}

/// 注册持久化钩子（只在状态翻转时调用，写盘频率极低）。
pub fn set_persist_hook(f: Box<dyn Fn(bool) + Send + Sync>) {
    let _ = PERSIST.set(f);
}

fn remember_raw_unreachable(unreachable: bool) {
    if RAW_UNREACHABLE.swap(unreachable, Ordering::Relaxed) != unreachable {
        if let Some(persist) = PERSIST.get() {
            persist(unreachable);
        }
    }
}

/// 把 google/fonts 的 raw 地址改写成所有镜像地址（非 raw 地址返回空）。
pub fn mirror_urls(url: &str) -> Vec<String> {
    match url.strip_prefix(RAW_PREFIX) {
        Some(rest) => MIRROR_PREFIXES
            .iter()
            .map(|prefix| format!("{prefix}{rest}"))
            .collect(),
        None => Vec::new(),
    }
}

async fn fetch_bytes(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    check_host(url)?;
    let res = client
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{} returned HTTP {}", url, res.status().as_u16()));
    }
    res.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

/// 4xx（除 429 限流）说明「这个文件本身不存在」，换镜像也没用，可以直接结束。
fn is_terminal(err: &str) -> bool {
    err.contains("HTTP 404") || err.contains("HTTP 400") || err.contains("HTTP 410")
}

/// 先请求原始地址，失败时轮询镜像；网络恢复后会自动回到原始地址直连。
async fn fetch_with_mirror(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    check_host(url)?;
    let mirrors = mirror_urls(url);
    if mirrors.is_empty() {
        return fetch_bytes(client, url, TIMEOUT).await;
    }

    let mut last_err = String::new();
    if !RAW_UNREACHABLE.load(Ordering::Relaxed) {
        match fetch_bytes(client, url, RAW_TIMEOUT).await {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                if is_terminal(&err) {
                    return Err(err);
                }
                remember_raw_unreachable(true);
                last_err = err;
            }
        }
    }

    for mirror in &mirrors {
        match fetch_bytes(client, mirror, TIMEOUT).await {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                if is_terminal(&err) {
                    return Err(err);
                }
                last_err = format!("{last_err}; mirror {mirror}: {err}");
            }
        }
    }

    // 镜像也全部失败：再试一次原始地址，成功则说明网络已恢复。
    match fetch_bytes(client, url, RAW_TIMEOUT).await {
        Ok(bytes) => {
            remember_raw_unreachable(false);
            Ok(bytes)
        }
        Err(err) => Err(format!("{last_err}; raw: {err}")),
    }
}

pub async fn get_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let bytes = fetch_with_mirror(client, url).await?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

pub async fn get_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    fetch_with_mirror(client, url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_refuses_when_disabled() {
        let state = AppState::default();
        assert!(!state.online_fonts_enabled);
        assert!(client(&state).is_err());
    }

    #[test]
    fn host_allow_list() {
        assert!(check_host("https://api.fontsource.org/v1/fonts").is_ok());
        assert!(check_host("https://raw.githubusercontent.com/google/fonts/main/ofl/lora/OFL.txt").is_ok());
        assert!(check_host("https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/lora/OFL.txt").is_ok());
        assert!(check_host("https://fastly.jsdelivr.net/gh/google/fonts@main/ofl/lora/OFL.txt").is_ok());
        assert!(check_host("https://fonts.googleapis.com/css2?family=Lora").is_err());
        assert!(check_host("http://api.fontsource.org/v1/fonts").is_err());
        assert!(check_host("https://evil.example/").is_err());
    }

    #[test]
    fn mirror_rewrites_raw_urls_only() {
        let urls = mirror_urls("https://raw.githubusercontent.com/google/fonts/main/ofl/lora/METADATA.pb");
        assert_eq!(urls.len(), MIRROR_PREFIXES.len());
        assert_eq!(
            urls[0],
            "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/lora/METADATA.pb"
        );
        assert!(urls
            .iter()
            .all(|u| u.ends_with("/ofl/lora/METADATA.pb") && check_host(u).is_ok()));
        assert_eq!(
            mirror_urls("https://raw.githubusercontent.com/google/fonts/main/ofl/lora/Lora%5Bwght%5D.ttf").first(),
            Some(&"https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/lora/Lora%5Bwght%5D.ttf".to_string()),
        );
        // 非raw 源、其他仓库不做镜像
        assert!(mirror_urls("https://api.fontsource.org/v1/fonts").is_empty());
        assert!(
            mirror_urls("https://raw.githubusercontent.com/other/repo/main/x.txt").is_empty(),
        );
    }

    #[test]
    fn terminal_errors_are_not_retried() {
        assert!(is_terminal("https://x/y returned HTTP 404"));
        assert!(!is_terminal("error sending request for url"));
        assert!(!is_terminal("https://x/y returned HTTP 429"));
    }
}
