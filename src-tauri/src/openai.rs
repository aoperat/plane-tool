use serde::Deserialize;

/// OpenAI Chat Completions 최소 클라이언트. 브리핑 한 번에 호출 한 번이라
/// 재시도 없이 30초 타임아웃만 둔다 — 실패하면 호출자가 규칙 기반으로 폴백한다.
pub struct OpenAiClient {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct ChatMessage { content: String }
#[derive(Deserialize)]
struct ChatChoice { message: ChatMessage }
#[derive(Deserialize)]
struct ChatResponse { choices: Vec<ChatChoice> }

impl OpenAiClient {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url("https://api.openai.com".into(), api_key)
    }

    pub fn with_base_url(base_url: String, api_key: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { base_url: base_url.trim_end_matches('/').to_string(), api_key, http }
    }

    /// system/user 메시지로 JSON 모드 응답을 요청하고 본문 문자열을 돌려준다.
    pub async fn chat_json(&self, model: &str, system: &str, user: &str) -> Result<String, String> {
        let url = format!("{}/v1/chat/completions", self.base_url);
        let body = serde_json::json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user }
            ],
            "response_format": { "type": "json_object" }
        });
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(300).collect();
            return Err(format!("OpenAI HTTP {status}: {snippet}"));
        }
        let parsed: ChatResponse = resp.json().await.map_err(|e| format!("OpenAI 응답 파싱 실패: {e}"))?;
        parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| "OpenAI 응답에 choices가 비어 있음".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn chat_json_sends_messages_and_returns_content() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("Authorization", "Bearer sk-test"))
            .and(body_partial_json(serde_json::json!({
                "model": "gpt-4o-mini",
                "response_format": { "type": "json_object" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "role": "assistant", "content": "{\"summary\":\"ok\"}" } }]
            })))
            .mount(&server)
            .await;
        let c = OpenAiClient::with_base_url(server.uri(), "sk-test".into());
        let out = c.chat_json("gpt-4o-mini", "시스템", "유저").await.unwrap();
        assert_eq!(out, "{\"summary\":\"ok\"}");
    }

    #[tokio::test]
    async fn chat_json_surfaces_http_error_with_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": { "message": "Incorrect API key provided" }
            })))
            .mount(&server)
            .await;
        let c = OpenAiClient::with_base_url(server.uri(), "sk-bad".into());
        let err = c.chat_json("gpt-4o-mini", "s", "u").await.unwrap_err();
        assert!(err.contains("401"), "got: {err}");
        assert!(err.contains("Incorrect API key"), "got: {err}");
    }

    #[tokio::test]
    async fn chat_json_errors_when_choices_missing() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "choices": [] })))
            .mount(&server)
            .await;
        let c = OpenAiClient::with_base_url(server.uri(), "sk-test".into());
        assert!(c.chat_json("gpt-4o-mini", "s", "u").await.is_err());
    }
}
