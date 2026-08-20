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

/// 분해 1단계의 산출물 — 모델이 문장에서 찾아낸 작업 단위 하나.
/// basis는 분해 기준(가/나/다) 중 어디에 걸렸는지다.
#[derive(Deserialize)]
struct RawUnit {
    #[serde(default)]
    title: String,
    #[serde(default)]
    basis: String,
}

#[derive(Deserialize)]
struct RawSuggestion {
    /// 2단계 응답(단위 나열 → 기계적 분해)에만 있다. 없으면(None) 구형
    /// 응답으로 보고 children을 그대로 믿는다.
    #[serde(default)]
    units: Option<Vec<RawUnit>>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    title_changed: bool,
    #[serde(default)]
    children: Vec<String>,
    #[serde(default)]
    reason: String,
}

/// 빈 것과 중복을 걸러 MAX_CHILDREN까지 담는다.
fn collect_children(iter: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in iter {
        let c = c.trim().to_string();
        if c.is_empty() || out.contains(&c) {
            continue;
        }
        out.push(c);
        if out.len() == MAX_CHILDREN {
            break;
        }
    }
    out
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
///
/// 어떤 개선을 원하는지는 호출자가 고른다 — `refine_title`은 제목 다듬기,
/// `split_children`은 하위 작업 분해. 둘 다 끈 조합은 커맨드가 미리 거르므로,
/// 여기까지 왔다면 둘 다 켠 것으로 본다.
///
/// `project_name`은 "프로젝트명 겹침 제거"를 켰을 때만 Some이다 — 그때만
/// 프로젝트 이름이 페이로드에 실려 나간다(사용자가 옵션으로 동의한 범위).
pub fn build_prompt(
    title: &str,
    description: &str,
    refine_title: bool,
    split_children: bool,
    project_name: Option<&str>,
) -> (String, String) {
    let (refine_title, split_children) =
        if !refine_title && !split_children { (true, true) } else { (refine_title, split_children) };
    // 다듬기를 껐으면 제목을 건드릴 수 없다 — 프로젝트명 제거도 제목 편집이다.
    let project_name = if refine_title { project_name.map(str::trim).filter(|p| !p.is_empty()) } else { None };

    let goal = match (refine_title, split_children) {
        (true, false) =>
            "사용자가 급히 적은 할 일 한 줄을 보고,\n\
             제목의 맞춤법·띄어쓰기·어색한 표현만 다듬는다. 작업을 쪼개지는 않는다.",
        (false, true) =>
            "사용자가 급히 적은 할 일 한 줄을 보고,\n\
             여러 작업이 섞여 있으면 상위 작업과 하위 작업으로 쪼갠다. 제목 문구는 고치지 않는다.",
        _ =>
            "사용자가 급히 적은 할 일 한 줄을 보고,\n\
             (1) 제목이 어설프면 다듬고 (2) 여러 작업이 섞여 있으면 상위 작업과 하위 작업으로 쪼갠다.",
    };

    // 분해를 켰을 때만 units 필드가 있다 — 1단계(단위 나열)를 건너뛰지 못하게
    // 응답 모양 자체에 박아 둔다.
    let shape = if split_children {
        "{\"units\": [{\"title\": \"작업 단위\", \"basis\": \"가|나|다, 한 단위뿐이면 빈 문자열\"}], \
          \"title\": \"상위 작업 제목\", \"title_changed\": false, \"children\": [], \"reason\": \"\"}"
    } else {
        "{\"title\": \"상위 작업 제목\", \"title_changed\": false, \"children\": [], \"reason\": \"\"}"
    };
    let mut system = format!(
        "당신은 업무 캡처를 다듬는 어시스턴트다. {goal}\n\
         반드시 아래 형태의 JSON만 응답한다 (다른 텍스트 금지):\n\
         {shape}\n\
         **손댈 이유를 찾지 못하면 원문을 그대로 title에 넣고 나머지는 기본값으로 답한다.**\n\
         규칙:\n"
    );
    if split_children {
        system.push_str(
            "- **순서를 지켜라: 먼저 세고, 그다음 쪼갠다.** 1단계 — 문장에서 완료 시점이\n\
               서로 다른 작업 단위를 찾아 units에 나열한다. 단위마다 어느 기준(가/나/다)에\n\
               걸렸는지 basis에 적는다. 문장 전체가 한자리에서 이어지는 하나의 일이면\n\
               units에 그 한 단위만 넣고 basis는 빈 문자열로 둔다.\n\
             - 2단계 — children은 units에서 기계적으로 나온다. 단위가 2개 이상이면 그\n\
               제목들이 그대로 children이고, 1개뿐이면 children은 빈 배열이다.\n\
               units와 children이 어긋나면 안 된다.\n\
             - **완료 시점이 실제로 다른 단계만 별개 단위다.** 판단 기준은 그 사이에\n\
               (가) 남의 응답·승인을 기다려야 하는가, (나) 보통 다른 날에 하는 일인가,\n\
               (다) 다른 도구·장소·자료로 옮겨가야 하는가 셋 중 하나다.\n\
               셋 다 아니면 한자리에서 이어서 끝나는 일이므로 **한 작업이다.**\n\
               아래 예시의 괄호가 어느 기준에 걸렸는지 보여준다 — 쪼갤 때는 반드시\n\
               (가)(나)(다) 중 하나를 댈 수 있어야 한다.\n\
                 · 쪼개지 않는다: \"메일 내용 작성\" + \"메일 전송\" → 셋 다 아니다. \"담당자에게 메일 전달\" 하나다\n\
                 · 쪼개지 않는다: \"문서 열기\" + \"내용 확인\" → 셋 다 아니다. 같은 동작의 앞뒤다\n\
                 · 쪼갠다: \"취약점 문서 확인\" + \"담당자에게 메일 전달\" → (다) 문서를 보다가 메일로 자리를 옮긴다\n\
                 · 쪼갠다: \"견적 요청\" + \"견적 검토\" → (가) 상대의 회신을 기다려야 한다\n\
                 · 쪼갠다: \"발표자료 작성\" + \"발표\" → (나) 보통 다른 날 한다\n\
                 · 쪼갠다: \"취약점 조치 및 전달\" → (다) 조치를 끝내고 메일·보고로 자리를 옮겨 전달한다.\n\
                   \"및\"으로 한 문장에 묶여 있어도 완료 시점이 다르면 별개의 작업이다\n\
             - **어디를 살펴볼지 알려주는 표현들.** 아래가 보이면 그 앞뒤를 나눠 검토해라.\n\
               다만 이건 신호일 뿐 쪼갤 이유가 아니다 — 쪼갤지는 위 세 기준으로 다시 판단한다.\n\
                 · 나열: \"및\", \"그리고\", \"와/과\", \"~랑\", 쉼표로 이어진 동사구\n\
                 · 순서: \"~한 후\", \"~하고 나서\", \"~ 뒤에\", \"~ 다음\", \"~까지 하고\"\n\
                 · 대상 전환: \"~에게\", \"~쪽에\", \"~로 넘겨\"\n\
                   단, 넘기는 행위 자체가 하나의 일이면 쪼개지 않는다 — \"담당자에게 메일 전달\"은 한 작업이다.\n\
               반대로 아래는 **한 작업이라는 신호**다. 이런 연결은 쪼개지 마라.\n\
                 · \"~해서\", \"~하여\", \"~하면서\", \"~한 뒤 바로\" — 한 동작의 앞뒤일 뿐이다\n\
                 · 수단·방법을 덧붙인 말 (\"메일로\", \"전화로\", \"문서로\")\n\
             - 하위 작업은 최대 4개. **적을수록 좋다** — 2개로 충분하면 2개만 낸다.\n\
             - 쪼갤 이유가 없으면 children을 빈 배열로 둔다. 억지로 만들지 않는다.\n\
               하나의 일을 동사만 바꿔 늘어놓는 것은 분해가 아니다.\n\
             - 하위 작업 제목은 그 자체로 무슨 일인지 알 수 있게 쓴다 (예: \"확인\" 대신 \"취약점 문서 확인\").\n",
        );
    } else {
        system.push_str("- children은 항상 빈 배열로 둔다. 작업을 쪼개는 것은 이번 요청의 범위가 아니다.\n");
    }
    if refine_title {
        system.push_str(
            "- 제목 개선이 뚜렷하지 않으면 title_changed를 false로 두고 원문을 그대로 title에 넣는다.\n\
             - 제목에 \"작업\", \"건\", \"처리\" 같은 군더더기를 덧붙이지 않는다.\n\
               (나쁜 예: \"주간보고 작성 작업\" → 좋은 예: \"주간보고 작성\")\n\
             - 다듬기는 표현만 고친다. \"~한 후\"를 \"및\"으로 바꾸는 식으로 순서나 의미를\n\
               바꾸는 것은 다듬기가 아니다.\n",
        );
        if project_name.is_some() {
            system.push_str(
                "- 제목이 프로젝트 이름(payload의 project)으로 시작하거나 그 이름을 반복하면\n\
                   그 부분을 지운다 — 작업은 이미 그 프로젝트 안에 있어 제목에 다시 쓸\n\
                   필요가 없다. (예: 프로젝트가 \"한빛대\"일 때 \"한빛대 서버 점검\" → \"서버 점검\")\n\
                   하위 작업 제목에도 넣지 않는다.\n",
            );
        }
    } else {
        system.push_str(
            "- title에는 받은 제목을 글자 그대로 넣고 title_changed는 항상 false로 둔다.\n\
               제목을 고치는 것은 이번 요청의 범위가 아니다.\n",
        );
    }
    system.push_str(
        "- 날짜·기한·순번은 제목에 넣지 않는다. 앱이 따로 관리한다.\n\
         - reason은 한국어 한 줄. 쪼갰으면 어느 기준에 걸렸는지, 제목만 다듬었으면 왜 바꿨는지 쓴다.\n\
           **실제로 바꾼 것만 쓴다** — 이 지시문의 예시 문구를 베껴 쓰지 않는다.\n\
           손댄 것이 없으면 반드시 빈 문자열.",
    );
    let mut payload = serde_json::Map::new();
    payload.insert("title".into(), serde_json::json!(title.trim()));
    if let Some(p) = project_name {
        payload.insert("project".into(), serde_json::json!(p));
    }
    let desc = description.trim();
    if !desc.is_empty() {
        payload.insert("description".into(), serde_json::json!(desc));
    }
    (system, serde_json::Value::Object(payload).to_string())
}

/// AI 응답을 검증해 안전한 제안으로 바꾼다. `original_title`은 제목이 비었을 때
/// 되돌아갈 자리다.
///
/// `refine_title`/`split_children`은 사용자가 고른 개선 범위다. 프롬프트는
/// 부탁일 뿐이라 모델이 범위를 벗어나 응답할 수 있다 — 강제는 여기서 한다.
pub fn parse_suggestion(
    content: &str,
    original_title: &str,
    refine_title: bool,
    split_children: bool,
) -> Result<BreakdownSuggestion, String> {
    let raw: RawSuggestion =
        serde_json::from_str(strip_fence(content)).map_err(|e| format!("AI 응답을 읽지 못했습니다: {e}"))?;

    let trimmed = raw.title.trim();
    let title = if trimmed.is_empty() { original_title.trim().to_string() } else { trimmed.to_string() };
    // 원본과 같은 제목을 "다듬었다"고 내보내면 시트에 의미 없는 비교 줄이 뜬다.
    let title_changed = raw.title_changed && title != original_title.trim();
    let (title, title_changed) = if refine_title {
        (title, title_changed)
    } else {
        (original_title.trim().to_string(), false)
    };

    let children: Vec<String> = if !split_children {
        Vec::new()
    } else {
        match raw.units {
            // 2단계 응답 — 단위 나열이 분해의 근거다. 단위가 하나뿐이면 children에
            // 무엇이 왔든 억지 분해로 보고 버리고, 단위가 여럿이어도 기준(가/나/다)을
            // 하나도 못 댔으면 근거 없는 분해라 받지 않는다.
            Some(units) => {
                let titles: Vec<String> =
                    units.iter().map(|u| u.title.trim().to_string()).filter(|t| !t.is_empty()).collect();
                let has_basis = units.iter().any(|u| matches!(u.basis.trim(), "가" | "나" | "다"));
                if titles.len() >= 2 && has_basis { collect_children(titles) } else { Vec::new() }
            }
            // units가 없는 구형 응답 — children을 그대로 믿는다.
            None => collect_children(raw.children),
        }
    };

    // 바꾼 것이 없는데 이유만 남으면 시트가 "이대로 충분합니다" 옆에 지어낸
    // 사연을 나란히 보여주게 된다 — 모델이 예시 문구를 베껴 reason을 채우는
    // 일이 실제로 있었다. 근거 없는 이유는 여기서 지운다.
    let reason = if title_changed || !children.is_empty() { raw.reason.trim().to_string() } else { String::new() };

    Ok(BreakdownSuggestion { title, title_changed, children, reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_well_formed_response() {
        let json = r#"{"title":"홍익대 취약점 대응","title_changed":true,
            "children":["취약점 문서 확인","조치 일정 수립"],"reason":"완료 시점이 다르다"}"#;
        let out = parse_suggestion(json, "원래 제목", true, true).unwrap();
        assert_eq!(out.title, "홍익대 취약점 대응");
        assert!(out.title_changed);
        assert_eq!(out.children, vec!["취약점 문서 확인", "조치 일정 수립"]);
        assert_eq!(out.reason, "완료 시점이 다르다");
    }

    /// 쪼갤 이유가 없으면 빈 배열이 정상 응답이다 — 오류가 아니다.
    #[test]
    fn accepts_an_empty_breakdown() {
        let json = r#"{"title":"원래 제목","title_changed":false,"children":[],"reason":""}"#;
        let out = parse_suggestion(json, "원래 제목", true, true).unwrap();
        assert!(out.children.is_empty());
        assert!(!out.title_changed);
    }

    #[test]
    fn caps_children_at_four() {
        let json = r#"{"title":"t","title_changed":false,
            "children":["a","b","c","d","e","f"],"reason":""}"#;
        let out = parse_suggestion(json, "t", true, true).unwrap();
        assert_eq!(out.children, vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn drops_blank_and_duplicate_children() {
        let json = r#"{"title":"t","title_changed":false,
            "children":["확인","  ","확인","전달"],"reason":""}"#;
        let out = parse_suggestion(json, "t", true, true).unwrap();
        assert_eq!(out.children, vec!["확인", "전달"]);
    }

    /// 제목이 비면 원본을 유지하고 title_changed도 거짓으로 내린다 —
    /// 빈 제목이 폼에 들어가면 등록 자체가 막힌다.
    #[test]
    fn falls_back_to_the_original_title_when_blank() {
        let json = r#"{"title":"   ","title_changed":true,"children":[],"reason":""}"#;
        let out = parse_suggestion(json, "원래 제목", true, true).unwrap();
        assert_eq!(out.title, "원래 제목");
        assert!(!out.title_changed);
    }

    /// 제목이 원본과 같으면 "다듬었다"고 말하지 않는다 — 시트에 의미 없는
    /// 비교 줄이 뜨는 것을 막는다.
    #[test]
    fn clears_the_changed_flag_when_the_title_is_identical() {
        let json = r#"{"title":" 원래 제목 ","title_changed":true,"children":[],"reason":""}"#;
        let out = parse_suggestion(json, "원래 제목", true, true).unwrap();
        assert!(!out.title_changed);
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_suggestion("not json at all", "t", true, true).is_err());
    }

    /// 모델이 JSON을 코드펜스로 감싸는 일이 흔하다.
    #[test]
    fn tolerates_a_fenced_json_block() {
        let json = "```json\n{\"title\":\"t\",\"title_changed\":false,\"children\":[],\"reason\":\"\"}\n```";
        assert!(parse_suggestion(json, "t", true, true).is_ok());
    }

    #[test]
    fn prompt_carries_the_title_and_description() {
        let (system, user) = build_prompt("문서 확인 및 메일 전달", "홍익대 건", true, true, None);
        assert!(system.contains("완료 시점"), "분해 기준이 프롬프트에 있어야 한다");
        // 실사용에서 "메일 내용 작성"과 "메일 전송"이 둘로 쪼개져 나왔다. 기준을
        // 문장으로만 주면 모델이 적용하지 못한다 — 반례가 프롬프트에 있어야 한다.
        assert!(system.contains("메일 전송"), "쪼개지 않는 반례가 있어야 한다");
        assert!(system.contains("군더더기"), "제목 군더더기 금지 규칙이 있어야 한다");
        // 접속 표현은 "여기를 보라"는 신호일 뿐 쪼갤 이유가 아니다. 한 작업임을
        // 알리는 표현("~해서")까지 함께 줘야 신호가 과분해로 기울지 않는다.
        assert!(system.contains("\"및\""), "나열 신호가 있어야 한다");
        assert!(system.contains("~한 후"), "순서 신호가 있어야 한다");
        assert!(system.contains("~해서"), "한 작업이라는 신호도 함께 있어야 한다");
        assert!(system.contains("최대 4개"));
        let payload: serde_json::Value = serde_json::from_str(&user).unwrap();
        assert_eq!(payload["title"], "문서 확인 및 메일 전달");
        assert_eq!(payload["description"], "홍익대 건");
    }

    /// 설명이 비면 키 자체를 넣지 않는다 — 빈 문자열을 보내면 모델이 그것을
    /// 단서로 오해해 엉뚱한 하위를 지어낸다.
    #[test]
    fn prompt_omits_an_empty_description() {
        let (_, user) = build_prompt("제목만 있음", "   ", true, true, None);
        let payload: serde_json::Value = serde_json::from_str(&user).unwrap();
        assert!(payload.get("description").is_none());
    }

    /// 2단계 응답에서 분해의 근거는 units다 — children이 어긋나게 와도 units가 이긴다.
    #[test]
    fn units_drive_the_children() {
        let json = r#"{"units":[{"title":"취약점 조치","basis":"다"},{"title":"담당자에게 전달","basis":"다"}],
            "title":"t","title_changed":false,"children":["엉뚱한 하위"],"reason":"자리 이동"}"#;
        let out = parse_suggestion(json, "t", true, true).unwrap();
        assert_eq!(out.children, vec!["취약점 조치", "담당자에게 전달"]);
    }

    /// 단위가 하나뿐인데 children이 온 것은 억지 분해다 — 버린다.
    #[test]
    fn a_single_unit_kills_forced_children() {
        let json = r#"{"units":[{"title":"메일 전달","basis":""}],
            "title":"t","title_changed":false,"children":["메일 내용 작성","메일 전송"],"reason":""}"#;
        let out = parse_suggestion(json, "t", true, true).unwrap();
        assert!(out.children.is_empty());
    }

    /// 단위가 여럿이어도 기준(가/나/다)을 하나도 못 댔으면 분해 근거가 없다.
    #[test]
    fn units_without_any_basis_do_not_split() {
        let json = r#"{"units":[{"title":"확인","basis":""},{"title":"전달","basis":"아무거나"}],
            "title":"t","title_changed":false,"children":[],"reason":""}"#;
        let out = parse_suggestion(json, "t", true, true).unwrap();
        assert!(out.children.is_empty());
    }

    /// 분해를 켠 프롬프트는 "세고 나서 쪼갠다" 순서를 강제한다.
    #[test]
    fn split_prompt_demands_units_first() {
        let (system, _) = build_prompt("t", "", true, true, None);
        assert!(system.contains("\"units\""), "응답 모양에 units가 있어야 한다");
        assert!(system.contains("먼저 세고"), "단계 순서가 명시돼야 한다");
        assert!(system.contains("기계적으로"), "children이 units에서 나온다는 규칙이 있어야 한다");
    }

    /// 다듬기만 켜면 units를 요구하지 않는다 — 분해가 없는데 세라고 하면 헷갈린다.
    #[test]
    fn refine_only_prompt_has_no_units() {
        let (system, _) = build_prompt("t", "", true, false, None);
        assert!(!system.contains("\"units\""));
    }

    /// 프로젝트명 겹침 제거를 켜면 이름이 페이로드에 실리고 제거 규칙이 붙는다.
    #[test]
    fn project_name_rides_along_when_dedupe_is_on() {
        let (system, user) = build_prompt("한빛대 서버 점검", "", true, true, Some("한빛대"));
        assert!(system.contains("프로젝트 이름"), "제거 규칙이 있어야 한다");
        let payload: serde_json::Value = serde_json::from_str(&user).unwrap();
        assert_eq!(payload["project"], "한빛대");
    }

    /// 다듬기를 껐으면 프로젝트명 제거도 제목 편집이라 함께 꺼진다 — 이름도
    /// 내보내지 않는다(옵션으로 동의한 범위 밖).
    #[test]
    fn project_name_is_dropped_when_refine_is_off() {
        let (system, user) = build_prompt("한빛대 서버 점검", "", false, true, Some("한빛대"));
        assert!(!system.contains("프로젝트 이름"));
        let payload: serde_json::Value = serde_json::from_str(&user).unwrap();
        assert!(payload.get("project").is_none());
    }

    /// 실사용 회귀: "취약점 조치 및 전달"을 모델이 "이대로 충분"이라며 쪼개지
    /// 않았다. 원인은 군더더기 규칙의 좋은 예가 바로 그 문구여서 — 모델이
    /// 이상적인 최종 제목으로 학습해 분해를 거부했다. 예시 문구가 서로
    /// 겹치면 안 된다.
    #[test]
    fn prompt_split_example_must_not_double_as_a_good_title() {
        let (system, _) = build_prompt("취약점 조치 및 전달", "", true, true, None);
        assert!(system.contains("\"취약점 조치 및 전달\" → (다)"), "합성 문장을 쪼개는 예시가 있어야 한다");
        assert!(!system.contains("홍익대"), "같은 문구가 좋은 예(최종 제목)로 다시 나오면 안 된다");
        assert!(system.contains("주간보고 작성"), "군더더기 예시는 분해 예시와 다른 소재여야 한다");
    }

    /// 실사용 회귀: "조치 후 전달"이 "조치 및 전달"로 바뀌어 순서 정보가
    /// 사라졌다. 다듬기는 표현만 고쳐야 한다.
    #[test]
    fn prompt_forbids_meaning_changes_when_refining() {
        let (system, _) = build_prompt("문서 확인 후 전달", "", true, false, None);
        assert!(system.contains("순서나 의미"), "의미 보존 규칙이 있어야 한다");
    }

    /// 실사용 회귀: 아무것도 안 바꾸고 "군더더기를 제거하여 다듬음"이라는
    /// 지어낸 이유가 왔다 — 시트가 "이대로 충분합니다" 옆에 그대로 보여줬다.
    #[test]
    fn parser_clears_a_fabricated_reason_when_nothing_changed() {
        let json = r#"{"title":"취약점 조치 및 전달","title_changed":false,
            "children":[],"reason":"군더더기를 제거하여 제목을 간결하게 다듬음"}"#;
        let out = parse_suggestion(json, "취약점 조치 및 전달", true, true).unwrap();
        assert_eq!(out.reason, "");
    }

    /// 반대로 실제로 바꾼 것이 있으면 이유는 살아 있어야 한다.
    #[test]
    fn parser_keeps_the_reason_when_something_changed() {
        let json = r#"{"title":"t","title_changed":false,
            "children":["조치","전달"],"reason":"완료 시점이 다르다"}"#;
        let out = parse_suggestion(json, "t", true, true).unwrap();
        assert_eq!(out.reason, "완료 시점이 다르다");
    }

    /// 다듬기만 켠 프롬프트에는 분해 규칙이 없어야 한다 — 규칙이 남아 있으면
    /// 모델이 "쪼개도 된다"는 신호로 읽는다.
    #[test]
    fn refine_only_prompt_forbids_splitting() {
        let (system, _) = build_prompt("문서 확인 및 메일 전달", "", true, false, None);
        assert!(system.contains("children은 항상 빈 배열"), "분해 금지가 명시돼야 한다");
        assert!(!system.contains("완료 시점"), "분해 기준이 남아 있으면 안 된다");
        assert!(system.contains("군더더기"), "제목 다듬기 규칙은 유지된다");
    }

    /// 분해만 켠 프롬프트에는 제목 다듬기 규칙이 없어야 한다.
    #[test]
    fn split_only_prompt_forbids_title_edits() {
        let (system, _) = build_prompt("문서 확인 및 메일 전달", "", false, true, None);
        assert!(system.contains("title_changed는 항상 false"), "제목 고정이 명시돼야 한다");
        assert!(!system.contains("군더더기"), "다듬기 규칙이 남아 있으면 안 된다");
        assert!(system.contains("완료 시점"), "분해 기준은 유지된다");
    }

    /// 프롬프트는 부탁일 뿐이다 — 모델이 범위를 벗어나면 파서가 걷어낸다.
    #[test]
    fn parser_drops_title_edits_when_refine_is_off() {
        let json = r#"{"title":"멋대로 고친 제목","title_changed":true,
            "children":["확인","전달"],"reason":""}"#;
        let out = parse_suggestion(json, "원래 제목", false, true).unwrap();
        assert_eq!(out.title, "원래 제목");
        assert!(!out.title_changed);
        assert_eq!(out.children, vec!["확인", "전달"]);
    }

    #[test]
    fn parser_drops_children_when_split_is_off() {
        let json = r#"{"title":"다듬은 제목","title_changed":true,
            "children":["멋대로 쪼갠 하위"],"reason":""}"#;
        let out = parse_suggestion(json, "원래 제목", true, false).unwrap();
        assert_eq!(out.title, "다듬은 제목");
        assert!(out.title_changed);
        assert!(out.children.is_empty());
    }

    /// 회귀 방지: 담당자·프로젝트·작업 id 같은 사람/조직 정보는 절대 나가지 않는다.
    ///
    /// 검사 대상은 **user 페이로드뿐이다.** 실제 사용자 데이터가 실리는 곳이
    /// 거기이기 때문이다. system은 고정 지시문이라 "담당자에게 메일 전달" 같은
    /// 일반명사가 예시로 나올 수 있고, 그건 유출이 아니다.
    #[test]
    fn prompt_contains_no_identity_keys() {
        let (_, user) = build_prompt("제목", "설명", true, true, None);
        let payload: serde_json::Value = serde_json::from_str(&user).unwrap();
        let mut keys: Vec<&str> = payload.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable(); // serde_json::Map의 키 순서에 기대지 않는다
        assert_eq!(keys, vec!["description", "title"], "페이로드 키는 이 둘뿐이어야 한다");
    }
}
