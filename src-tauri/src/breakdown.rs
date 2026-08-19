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
}
