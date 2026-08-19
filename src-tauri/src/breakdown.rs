use serde::{Deserialize, Serialize};

/// 하위 작업 제안 개수 상한. 이보다 많으면 앞에서부터 자른다 — 다섯 개를 넘는
/// 분해는 캡처 한 번에 담기엔 너무 잘게 쪼갠 것이다.
pub const MAX_CHILDREN: usize = 4;

/// 검증을 통과한 제안. 프론트로 그대로 나간다.
#[derive(Debug, Clone, Serialize)]
pub struct BreakdownSuggestion {
    /// 다듬어진 제목(또는 원본 그대로).
    pub title: String,
    /// 제목을 실제로 바꿨는가. 거짓이면 시트에 비교 줄을 그리지 않는다.
    pub title_changed: bool,
    pub children: Vec<String>,
    /// 왜 이렇게 쪼갰는지 한 줄. 비어 있을 수 있다.
    pub reason: String,
}

#[derive(Deserialize)]
struct RawSuggestion {
    #[serde(default)]
    title: String,
    #[serde(default)]
    title_changed: bool,
    #[serde(default)]
    children: Vec<String>,
    #[serde(default)]
    reason: String,
}

/// 모델이 JSON을 ```json 펜스로 감싸 보내는 일이 흔하다. 첫 '{'부터 마지막
/// '}'까지만 잘라 쓴다.
fn strip_fence(s: &str) -> &str {
    match (s.find('{'), s.rfind('}')) {
        (Some(a), Some(b)) if b > a => &s[a..=b],
        _ => s,
    }
}

/// LLM에 보낼 (system, user) 메시지. user 페이로드에는 제목과 설명만 담는다 —
/// 담당자·프로젝트·작업 id 같은 사람/조직 정보는 분해에 필요 없고, 굳이 외부로
/// 내보낼 이유도 없다.
pub fn build_prompt(title: &str, description: &str) -> (String, String) {
    let system = format!(
        "당신은 업무 캡처를 다듬는 어시스턴트다. 사용자가 급히 적은 할 일 한 줄을 보고,\n\
         (1) 제목이 어설프면 다듬고 (2) 여러 작업이 섞여 있으면 상위 작업과 하위 작업으로 쪼갠다.\n\
         반드시 아래 형태의 JSON만 응답한다 (다른 텍스트 금지):\n\
         {{\"title\": \"상위 작업 제목\", \"title_changed\": true, \"children\": [\"하위 작업\"], \"reason\": \"한 줄 이유\"}}\n\
         규칙:\n\
         - **완료 시점이 실제로 다른 단계만 쪼갠다.** 같은 자리에서 연달아 끝나는 일은 하위 작업이 아니다.\n\
         - 하위 작업은 최대 4개.\n\
         - 쪼갤 이유가 없으면 children을 빈 배열로 둔다. 억지로 만들지 않는다.\n\
         - 제목 개선이 뚜렷하지 않으면 title_changed를 false로 두고 원문을 그대로 title에 넣는다.\n\
         - 하위 작업 제목은 그 자체로 무슨 일인지 알 수 있게 쓴다 (예: \"확인\" 대신 \"취약점 문서 확인\").\n\
         - 날짜·기한·순번은 제목에 넣지 않는다. 앱이 따로 관리한다.\n\
         - reason은 왜 그렇게 쪼갰는지 한국어 한 줄. 쪼개지 않았으면 빈 문자열."
    );
    let mut payload = serde_json::Map::new();
    payload.insert("title".into(), serde_json::json!(title.trim()));
    let desc = description.trim();
    if !desc.is_empty() {
        payload.insert("description".into(), serde_json::json!(desc));
    }
    (system, serde_json::Value::Object(payload).to_string())
}

/// AI 응답을 검증해 안전한 제안으로 바꾼다. `original_title`은 제목이 비었을 때
/// 되돌아갈 자리다.
pub fn parse_suggestion(content: &str, original_title: &str) -> Result<BreakdownSuggestion, String> {
    let raw: RawSuggestion =
        serde_json::from_str(strip_fence(content)).map_err(|e| format!("AI 응답을 읽지 못했습니다: {e}"))?;

    let trimmed = raw.title.trim();
    let title = if trimmed.is_empty() { original_title.trim().to_string() } else { trimmed.to_string() };
    // 원본과 같은 제목을 "다듬었다"고 내보내면 시트에 의미 없는 비교 줄이 뜬다.
    let title_changed = raw.title_changed && title != original_title.trim();

    let mut children: Vec<String> = Vec::new();
    for c in raw.children {
        let c = c.trim().to_string();
        if c.is_empty() || children.contains(&c) {
            continue;
        }
        children.push(c);
        if children.len() == MAX_CHILDREN {
            break;
        }
    }

    Ok(BreakdownSuggestion { title, title_changed, children, reason: raw.reason.trim().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_well_formed_response() {
        let json = r#"{"title":"홍익대 취약점 대응","title_changed":true,
            "children":["취약점 문서 확인","조치 일정 수립"],"reason":"완료 시점이 다르다"}"#;
        let out = parse_suggestion(json, "원래 제목").unwrap();
        assert_eq!(out.title, "홍익대 취약점 대응");
        assert!(out.title_changed);
        assert_eq!(out.children, vec!["취약점 문서 확인", "조치 일정 수립"]);
        assert_eq!(out.reason, "완료 시점이 다르다");
    }

    /// 쪼갤 이유가 없으면 빈 배열이 정상 응답이다 — 오류가 아니다.
    #[test]
    fn accepts_an_empty_breakdown() {
        let json = r#"{"title":"원래 제목","title_changed":false,"children":[],"reason":""}"#;
        let out = parse_suggestion(json, "원래 제목").unwrap();
        assert!(out.children.is_empty());
        assert!(!out.title_changed);
    }

    #[test]
    fn caps_children_at_four() {
        let json = r#"{"title":"t","title_changed":false,
            "children":["a","b","c","d","e","f"],"reason":""}"#;
        let out = parse_suggestion(json, "t").unwrap();
        assert_eq!(out.children, vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn drops_blank_and_duplicate_children() {
        let json = r#"{"title":"t","title_changed":false,
            "children":["확인","  ","확인","전달"],"reason":""}"#;
        let out = parse_suggestion(json, "t").unwrap();
        assert_eq!(out.children, vec!["확인", "전달"]);
    }

    /// 제목이 비면 원본을 유지하고 title_changed도 거짓으로 내린다 —
    /// 빈 제목이 폼에 들어가면 등록 자체가 막힌다.
    #[test]
    fn falls_back_to_the_original_title_when_blank() {
        let json = r#"{"title":"   ","title_changed":true,"children":[],"reason":""}"#;
        let out = parse_suggestion(json, "원래 제목").unwrap();
        assert_eq!(out.title, "원래 제목");
        assert!(!out.title_changed);
    }

    /// 제목이 원본과 같으면 "다듬었다"고 말하지 않는다 — 시트에 의미 없는
    /// 비교 줄이 뜨는 것을 막는다.
    #[test]
    fn clears_the_changed_flag_when_the_title_is_identical() {
        let json = r#"{"title":" 원래 제목 ","title_changed":true,"children":[],"reason":""}"#;
        let out = parse_suggestion(json, "원래 제목").unwrap();
        assert!(!out.title_changed);
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_suggestion("not json at all", "t").is_err());
    }

    /// 모델이 JSON을 코드펜스로 감싸는 일이 흔하다.
    #[test]
    fn tolerates_a_fenced_json_block() {
        let json = "```json\n{\"title\":\"t\",\"title_changed\":false,\"children\":[],\"reason\":\"\"}\n```";
        assert!(parse_suggestion(json, "t").is_ok());
    }

    #[test]
    fn prompt_carries_the_title_and_description() {
        let (system, user) = build_prompt("문서 확인 및 메일 전달", "홍익대 건");
        assert!(system.contains("완료 시점"), "분해 기준이 프롬프트에 있어야 한다");
        assert!(system.contains("최대 4개"));
        let payload: serde_json::Value = serde_json::from_str(&user).unwrap();
        assert_eq!(payload["title"], "문서 확인 및 메일 전달");
        assert_eq!(payload["description"], "홍익대 건");
    }

    /// 설명이 비면 키 자체를 넣지 않는다 — 빈 문자열을 보내면 모델이 그것을
    /// 단서로 오해해 엉뚱한 하위를 지어낸다.
    #[test]
    fn prompt_omits_an_empty_description() {
        let (_, user) = build_prompt("제목만 있음", "   ");
        let payload: serde_json::Value = serde_json::from_str(&user).unwrap();
        assert!(payload.get("description").is_none());
    }

    /// 회귀 방지: 담당자·프로젝트·작업 id 같은 사람/조직 정보는 절대 나가지 않는다.
    #[test]
    fn prompt_contains_no_identity_keys() {
        let (system, user) = build_prompt("제목", "설명");
        for key in ["assignee", "project", "id", "user"] {
            assert!(!user.contains(key), "user 메시지에 {key}가 있으면 안 된다: {user}");
        }
        assert!(!system.contains("담당자"));
    }
}
