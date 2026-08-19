# AI 작업 분해 구현 계획 (2단계)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빠른 추가에서 `[✨ AI 제안]` 버튼을 누르면 AI가 입력을 검토해 제목을 다듬고 여러 작업이 섞였으면 상위+하위로 쪼개 제안한다. 적용하면 폼에 반영되고, 확정은 언제나 Ctrl+Enter다.

**Architecture:** AI 프롬프트 조립과 응답 검증은 `src-tauri/src/breakdown.rs`의 순수 함수가 맡고, HTTP는 기존 `openai.rs`의 얇은 클라이언트를 그대로 쓴다(브리핑과 같은 구조). 프론트는 `suggest_breakdown` 커맨드 하나로 검증된 결과를 받아 오버레이 시트로 보여주고, 확정 시 `create_issue_tree`가 부모→자식 순으로 만든다.

**Tech Stack:** Tauri 2 (Rust: reqwest/serde, wiremock 테스트), Vanilla TS + Vite 멀티페이지, vitest.

**Spec:** `docs/superpowers/specs/2026-08-18-parent-child-ai-breakdown-design.md`

**선행:** 1단계(상위/하위 계층)가 master에 병합돼 있어야 한다 — `create_issue`의
`parent_id`, `WorkItem.parent_id`/`sub_total`, 사이드바 계층 렌더가 그 결과물이다.

---

## Global Constraints

- UI 문구·AI 응답은 모두 한국어.
- OpenAI 키·모델은 **브리핑 설정을 그대로 재사용한다**(`config::get_openai_key()`,
  `Settings.briefing_model`). 새 설정 필드를 만들지 않는다.
- AI에는 **제목과 설명만** 보낸다 — 담당자·프로젝트명·작업 id는 보내지 않는다.
  브리핑이 설명을 절대 보내지 않는 것과는 반대 방향의 결정이다: 분해는 문장의
  내용을 봐야 하고, 대신 사람·조직 정보를 뺀다.
- AI 실패는 **폴백 없이 오류 메시지를 그대로 보여준다.** 브리핑과 달리 규칙 기반으로
  흉내 낼 것이 없다(억지 분해는 이 기능의 존재 이유를 무너뜨린다).
- 낙관적 업데이트 없음 — 트리 생성은 서버 응답을 기다린다. 부분 실패를 사용자에게
  정확히 알려야 하기 때문이다.
- 새 `Settings` 필드 없음. 마이그레이션 없음.
- 테스트: `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm test`,
  **타입 체크는 `npx tsc --noEmit`으로 따로**(`pnpm build`는 검사하지 않는다), 빌드 `pnpm build`.
- 마지막 태스크에서 CHANGELOG `[Unreleased]`에 한 줄 기록.

## File Structure

**Create:**
- `src-tauri/src/breakdown.rs` — 프롬프트 조립 + 응답 검증. 순수 함수만, HTTP 없음.
- `src/quickadd/breakdownSheet.ts` — 오버레이 시트 DOM. 선택 상태는 순수 함수로 분리.
- `src/quickadd/breakdownSheet.test.ts` — 위 선택 상태 테스트.

**Modify:**
- `src-tauri/src/lib.rs` — `mod breakdown;` 등록, 커맨드 2개 핸들러 등록.
- `src-tauri/src/commands.rs` — `suggest_breakdown` / `create_issue_tree` 커맨드.
- `src-tauri/src/plane_api.rs` — 없음(1단계의 `NewWorkItem.parent_id`를 그대로 쓴다).
- `src/shared/types.ts` — `BreakdownSuggestion`, `TreeCreateResult`.
- `src/shared/ipc.ts` — 커맨드 2개 래퍼.
- `src/quickadd/index.html` — 시트 템플릿, 푸터에 AI 버튼.
- `src/quickadd/main.ts` — 버튼 배선, 시트 열기, 적용 후 상태, 트리 등록.
- `src/shared/app.css` — 시트·버튼 스타일.

---

### Task 1: 응답 검증 (Rust 순수 함수)

AI가 무엇을 돌려주든 앱이 안전하게 다루도록 먼저 방어선을 만든다. 이 태스크는
HTTP를 부르지 않는다.

**Files:**
- Create: `src-tauri/src/breakdown.rs`
- Modify: `src-tauri/src/lib.rs` (모듈 등록)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src-tauri/src/breakdown.rs`를 만들고 아래를 넣는다(구현은 아직 없다):

```rust
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
```

- [ ] **Step 2: 실패를 확인한다**

`src-tauri/src/lib.rs`에 `mod breakdown;`을 추가한 뒤:

Run: `cargo test --manifest-path src-tauri/Cargo.toml breakdown`
Expected: FAIL — `cannot find function parse_suggestion`

- [ ] **Step 3: 구현한다**

`src-tauri/src/breakdown.rs`의 `mod tests` **위에** 넣는다:

```rust
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
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml breakdown`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/breakdown.rs src-tauri/src/lib.rs
git commit -m "feat: AI 작업 분해 응답을 검증하는 순수 함수를 추가한다"
```

---

### Task 2: 프롬프트 조립 (Rust 순수 함수)

**Files:**
- Modify: `src-tauri/src/breakdown.rs`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`mod tests` 안에 추가한다:

```rust
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
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml breakdown::tests::prompt`
Expected: FAIL — `cannot find function build_prompt`

- [ ] **Step 3: 구현한다**

`parse_suggestion` 위에 넣는다:

```rust
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
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml breakdown`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/breakdown.rs
git commit -m "feat: AI 작업 분해 프롬프트를 조립한다"
```

---

### Task 3: `suggest_breakdown` 커맨드

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: 커맨드를 구현한다**

`src-tauri/src/commands.rs` 끝부분(`generate_briefing` 근처)에 넣는다:

```rust
/// 빠른 추가의 [✨ AI 제안]. 제목·설명을 OpenAI에 보내 제목 다듬기와 하위 작업
/// 분해를 제안받는다.
///
/// 브리핑과 달리 폴백이 없다 — 규칙 기반으로 흉내 낼 것이 없고, 억지 분해는 이
/// 기능의 존재 이유를 무너뜨린다. 실패는 그대로 오류로 올린다.
#[tauri::command]
pub async fn suggest_breakdown(
    app: tauri::AppHandle,
    title: String,
    description: String,
) -> Result<crate::breakdown::BreakdownSuggestion, String> {
    if title.trim().is_empty() {
        return Err("제목을 먼저 입력하세요".into());
    }
    let key = config::get_openai_key().ok_or("no_key")?;
    let s = config::load_settings(&app);
    let (system, user_msg) = crate::breakdown::build_prompt(&title, &description);
    let ai = crate::openai::OpenAiClient::new(key);
    let content = ai.chat_json(&s.briefing_model, &system, &user_msg).await?;
    crate::breakdown::parse_suggestion(&content, &title)
}
```

`config::load_settings(app: &tauri::AppHandle) -> Settings`는 `config.rs:113`에
이미 있다. 이 커맨드는 Plane 클라이언트가 필요 없으므로 `client(&app)`
(`commands.rs:224`)을 쓰지 않고 설정만 읽는다 — Plane 연결이 안 돼 있어도 AI
제안은 동작해야 한다.

- [ ] **Step 2: 핸들러를 등록한다**

`src-tauri/src/lib.rs`의 `tauri::generate_handler![...]` 목록에 `commands::suggest_breakdown`을 더한다.

- [ ] **Step 3: 컴파일과 기존 테스트를 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — 새 테스트는 없고 컴파일이 통과해야 한다.

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: AI 작업 분해를 요청하는 커맨드를 추가한다"
```

---

### Task 4: `create_issue_tree` 커맨드

부모를 먼저 만들고 그 id로 자식을 순차 생성한다. **부분 실패를 롤백하지 않는다** —
이미 만든 것을 지우는 것이 더 나쁜 실패 모드다.

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: 결과 타입과 커맨드를 구현한다**

`src-tauri/src/commands.rs`에 넣는다:

```rust
/// `create_issue_tree`의 결과. 부분 실패를 사용자에게 정확히 알리기 위해 만든
/// 것 수와 실패한 제목을 함께 돌려준다.
#[derive(Debug, Serialize)]
pub struct TreeCreateResult {
    pub parent_id: String,
    /// 실제로 만들어진 하위 작업 수.
    pub created: usize,
    /// 만들지 못한 하위 작업의 제목들.
    pub failed: Vec<String>,
}

/// 상위 작업 하나와 하위 작업 여럿을 한 번에 만든다. 하위는 상위의
/// 담당자·우선순위·기한을 그대로 물려받는다 — 한자리에서 만들어지는 것이라
/// 시작일도 같은 값이 맞다.
///
/// 부분 실패는 롤백하지 않는다. 이미 만든 것을 지우는 쪽이 더 나쁜 실패 모드다.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_issue_tree(
    app: tauri::AppHandle,
    project_id: String,
    name: String,
    children: Vec<String>,
    assignee_ids: Vec<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    priority: String,
    state_group: String,
    description: Option<String>,
) -> Result<TreeCreateResult, String> {
    if name.trim().is_empty() {
        return Err("empty_title".into());
    }
    let (client, _s) = client(&app)?;
    let parent_id = try_create_issue_online(
        &client, &project_id, name.trim(), &assignee_ids,
        start_date.as_deref(), target_date.as_deref(), &priority, &state_group,
        description.as_deref(), None,
    )
    .await?;

    let mut created = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for child in children {
        let child = child.trim();
        if child.is_empty() {
            continue;
        }
        match try_create_issue_online(
            &client, &project_id, child, &assignee_ids,
            start_date.as_deref(), target_date.as_deref(), &priority, &state_group,
            None, Some(&parent_id),
        )
        .await
        {
            Ok(_) => created += 1,
            Err(_) => failed.push(child.to_string()),
        }
    }

    config::set_last_project(&app, &project_id)?;
    crate::emit_shared_item_event(&app, "refresh-sidebar", ());
    Ok(TreeCreateResult { parent_id, created, failed })
}
```

`try_create_issue_online`의 시그니처는 1단계에서 이렇게 확정됐다 —
`(client, project_id, name, assignee_ids, start_date, target_date, priority,
state_group, description, parent_id)`. 위 코드의 인자 순서가 그것과 같다.

`.btn-ghost` 같은 보조 버튼 공용 클래스는 이 저장소에 없다(`app.css`에는
`.qa-submit`만 있다) — 그래서 Task 7에서 `.bd-cancel`을 직접 만든다.

- [ ] **Step 2: 핸들러를 등록한다**

`src-tauri/src/lib.rs`의 `generate_handler!`에 `commands::create_issue_tree`를 더한다.

- [ ] **Step 3: 확인한다**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (컴파일 통과)

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: 상위 작업과 하위 작업을 한 번에 만드는 커맨드를 추가한다"
```

---

### Task 5: 타입과 IPC 래퍼

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/ipc.ts`

- [ ] **Step 1: 타입을 더한다**

`src/shared/types.ts`에 넣는다:

```ts
/** AI가 제안한 분해 결과. Rust breakdown.rs의 BreakdownSuggestion과 같은 모양. */
export interface BreakdownSuggestion {
  title: string;
  /** 제목을 실제로 다듬었는가. 거짓이면 시트에 비교 줄을 그리지 않는다. */
  title_changed: boolean;
  children: string[];
  /** 왜 이렇게 쪼갰는지 한 줄. 비어 있을 수 있다. */
  reason: string;
}

/** 트리 생성 결과. 부분 실패를 알리기 위해 실패한 제목을 함께 받는다. */
export interface TreeCreateResult {
  parent_id: string;
  created: number;
  failed: string[];
}
```

- [ ] **Step 2: IPC 래퍼를 더한다**

`src/shared/ipc.ts`에 넣는다(`createIssue` 근처):

```ts
export const suggestBreakdown = (title: string, description: string) =>
  invoke<BreakdownSuggestion>("suggest_breakdown", { title, description });

export const createIssueTree = (
  project_id: string,
  name: string,
  children: string[],
  assignee_ids: string[],
  start_date: string | undefined,
  target_date: string | undefined,
  priority: string,
  state_group: string,
  description: string,
) =>
  invoke<TreeCreateResult>("create_issue_tree", {
    projectId: project_id,
    name,
    children,
    assigneeIds: assignee_ids,
    startDate: start_date,
    targetDate: target_date,
    priority,
    stateGroup: state_group,
    description,
  });
```

import 줄에 `BreakdownSuggestion`, `TreeCreateResult`를 더한다.

- [ ] **Step 3: 확인한다**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 4: 커밋**

```bash
git add src/shared/types.ts src/shared/ipc.ts
git commit -m "feat: AI 작업 분해 커맨드의 프론트 배선을 추가한다"
```

---

### Task 6: 시트 선택 상태 (순수 함수)

시트에서 사용자가 하위를 끄고 켜고 고치는 상태를 DOM 없이 다룬다.

**Files:**
- Create: `src/quickadd/breakdownSheet.ts`, `src/quickadd/breakdownSheet.test.ts`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/quickadd/breakdownSheet.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSheetState, toggleChild, editChild, acceptedChildren, hasAnythingToApply } from "./breakdownSheet";
import type { BreakdownSuggestion } from "../shared/types";

function suggestion(over: Partial<BreakdownSuggestion> = {}): BreakdownSuggestion {
  return { title: "홍익대 취약점 대응", title_changed: true, children: ["문서 확인", "메일 전달"], reason: "완료 시점이 다르다", ...over };
}

describe("breakdownSheet 상태", () => {
  it("처음에는 모든 하위가 켜져 있다", () => {
    const s = createSheetState(suggestion());
    expect(acceptedChildren(s)).toEqual(["문서 확인", "메일 전달"]);
  });

  it("끈 하위는 결과에서 빠진다", () => {
    const s = toggleChild(createSheetState(suggestion()), 1);
    expect(acceptedChildren(s)).toEqual(["문서 확인"]);
  });

  it("껐다 다시 켜면 원래 자리로 돌아온다", () => {
    let s = toggleChild(createSheetState(suggestion()), 0);
    s = toggleChild(s, 0);
    expect(acceptedChildren(s)).toEqual(["문서 확인", "메일 전달"]);
  });

  it("고친 제목이 결과에 반영된다", () => {
    const s = editChild(createSheetState(suggestion()), 0, "취약점 문서 확인");
    expect(acceptedChildren(s)).toEqual(["취약점 문서 확인", "메일 전달"]);
  });

  it("빈 제목으로 고치면 그 하위는 빠진다", () => {
    const s = editChild(createSheetState(suggestion()), 0, "   ");
    expect(acceptedChildren(s)).toEqual(["메일 전달"]);
  });

  /// 제목도 안 바뀌고 하위도 없으면 적용할 것이 없다 — 시트는 "이대로 충분합니다"만 보여준다.
  it("제목 변경도 하위도 없으면 적용할 것이 없다", () => {
    const s = createSheetState(suggestion({ title_changed: false, children: [] }));
    expect(hasAnythingToApply(s)).toBe(false);
  });

  it("하위를 전부 꺼도 제목 변경이 남아 있으면 적용할 것이 있다", () => {
    let s = createSheetState(suggestion());
    s = toggleChild(s, 0);
    s = toggleChild(s, 1);
    expect(acceptedChildren(s)).toEqual([]);
    expect(hasAnythingToApply(s)).toBe(true);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm test breakdownSheet`
Expected: FAIL — `Failed to resolve import "./breakdownSheet"`

- [ ] **Step 3: 구현한다**

`src/quickadd/breakdownSheet.ts`:

```ts
import type { BreakdownSuggestion } from "../shared/types";

export interface SheetChild {
  text: string;
  /** 사용자가 켜 둔 항목인가. 끈 것은 등록되지 않는다. */
  on: boolean;
}

export interface SheetState {
  title: string;
  titleChanged: boolean;
  reason: string;
  children: SheetChild[];
}

export function createSheetState(s: BreakdownSuggestion): SheetState {
  return {
    title: s.title,
    titleChanged: s.title_changed,
    reason: s.reason,
    children: s.children.map((text) => ({ text, on: true })),
  };
}

/** 체크를 뒤집는다. 상태를 갈아치우지 않고 새 객체를 돌려준다 — 렌더가
 *  이전 상태와 비교할 수 있어야 한다. */
export function toggleChild(state: SheetState, index: number): SheetState {
  const children = state.children.map((c, i) => (i === index ? { ...c, on: !c.on } : c));
  return { ...state, children };
}

export function editChild(state: SheetState, index: number, text: string): SheetState {
  const children = state.children.map((c, i) => (i === index ? { ...c, text } : c));
  return { ...state, children };
}

/** 실제로 만들 하위 작업 제목들. 꺼진 것과 빈 것은 빠진다. */
export function acceptedChildren(state: SheetState): string[] {
  return state.children.filter((c) => c.on && c.text.trim() !== "").map((c) => c.text.trim());
}

/** 적용 버튼을 눌러 바뀔 것이 하나라도 있는가. 제목도 그대로고 하위도 없으면
 *  시트는 "지금 이대로 충분합니다"만 보여주고 닫힌다. */
export function hasAnythingToApply(state: SheetState): boolean {
  return state.titleChanged || acceptedChildren(state).length > 0;
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm test breakdownSheet`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/quickadd/breakdownSheet.ts src/quickadd/breakdownSheet.test.ts
git commit -m "feat: AI 제안 시트의 선택 상태를 다루는 순수 함수를 추가한다"
```

---

### Task 7: 시트 UI와 AI 버튼

**Files:**
- Modify: `src/quickadd/index.html`, `src/shared/app.css`, `src/quickadd/main.ts`, `src/quickadd/breakdownSheet.ts`

- [ ] **Step 1: CSS를 추가한다**

`src/shared/app.css` 끝에 넣는다:

```css
/* AI 제안 버튼 — 푸터에서 [추가] 왼쪽에 선다. */
.qa-ai {
  background: transparent; border: 1px solid var(--accent-ring); color: var(--accent);
  border-radius: 8px; padding: 5px 10px; font-size: 12px; font-family: inherit;
  cursor: pointer; white-space: nowrap;
}
.qa-ai:hover { background: var(--accent-soft); }
.qa-ai:disabled { opacity: 0.5; cursor: default; }
/* 제안 시트 — 카드 위에 겹쳐 뜬다. 창 크기는 바뀌지 않는다(기존 .qa-coach와 같은 방식). */
.bd-overlay {
  position: absolute; inset: 0; z-index: 40; border-radius: var(--radius);
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  display: flex; align-items: center; justify-content: center; padding: 10px;
}
.bd-sheet {
  width: 100%; max-height: 100%; overflow: auto;
  background: var(--panel); border: 1px solid var(--accent-ring); border-radius: 10px;
  box-shadow: var(--shadow); padding: 11px;
}
.bd-head { display: flex; align-items: center; gap: 6px; color: var(--accent); font-size: 11px; font-weight: 600; margin-bottom: 8px; }
.bd-head .esc { margin-left: auto; color: var(--muted); font-weight: 400; }
.bd-title { font-size: 12px; margin-bottom: 8px; line-height: 1.5; }
.bd-title .old { color: var(--muted-2); text-decoration: line-through; }
.bd-title .arrow { color: var(--accent); }
.bd-child { display: flex; align-items: center; gap: 8px; background: var(--surface-task); border: 1px solid var(--surface-task-border); border-radius: 6px; padding: 6px 8px; margin-bottom: 5px; }
.bd-child input[type="checkbox"] { accent-color: var(--accent); flex: none; margin: 0; }
.bd-child input[type="text"] { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: var(--text); font-size: 12px; font-family: inherit; }
.bd-child.off input[type="text"] { color: var(--muted-2); text-decoration: line-through; }
.bd-reason { color: var(--muted); font-size: 11px; margin: 8px 0; }
.bd-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
/* 취소 버튼. 이 저장소에는 보조 버튼 공용 클래스가 없어(.qa-submit만 있다)
   여기서 직접 그린다. */
.bd-cancel {
  background: transparent; border: 1px solid var(--border); color: var(--muted);
  border-radius: 8px; padding: 5px 12px; font-size: 12px; font-family: inherit; cursor: pointer;
}
.bd-cancel:hover { color: var(--text); border-color: var(--muted); }
.bd-empty { color: var(--muted); font-size: 12px; padding: 6px 2px 10px; }
```

- [ ] **Step 2: 푸터에 버튼을 넣는다**

`src/quickadd/index.html`의 `qaFooter` 템플릿에서 `qaSubmit` **앞에** 넣는다:

```html
        <button type="button" id="qaAiBtn" class="qa-ai">✨ AI 제안</button>
```

- [ ] **Step 3: 시트 렌더 함수를 만든다**

`src/quickadd/breakdownSheet.ts`에 아래를 더한다(순수 함수 아래에):

```ts
export interface SheetHandle {
  close: () => void;
}

/** 카드 위에 겹치는 제안 시트를 연다. 적용을 누르면 onApply가 최종 상태를 받는다.
 *  Esc/취소는 아무것도 바꾸지 않고 닫는다. */
export function openBreakdownSheet(opts: {
  host: HTMLElement;
  suggestion: BreakdownSuggestion;
  originalTitle: string;
  onApply: (title: string, children: string[]) => void;
}): SheetHandle {
  let state = createSheetState(opts.suggestion);

  const overlay = document.createElement("div");
  overlay.className = "bd-overlay";
  const sheet = document.createElement("div");
  sheet.className = "bd-sheet";
  overlay.appendChild(sheet);

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // 사이드바·창 닫기까지 번지지 않게 여기서 멈춘다
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  function render() {
    sheet.innerHTML = "";

    const head = document.createElement("div");
    head.className = "bd-head";
    head.appendChild(document.createTextNode("✨ AI 제안"));
    const esc = document.createElement("span");
    esc.className = "esc";
    esc.textContent = "Esc 닫기";
    head.appendChild(esc);
    sheet.appendChild(head);

    if (!hasAnythingToApply(state) && state.children.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bd-empty";
      empty.textContent = "지금 이대로 충분합니다 — 쪼갤 만한 단계가 보이지 않습니다.";
      sheet.appendChild(empty);
    }

    if (state.titleChanged) {
      const t = document.createElement("div");
      t.className = "bd-title";
      const old = document.createElement("span");
      old.className = "old";
      old.textContent = opts.originalTitle;
      t.appendChild(old);
      t.appendChild(document.createElement("br"));
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "↳ ";
      t.appendChild(arrow);
      t.appendChild(document.createTextNode(state.title));
      sheet.appendChild(t);
    }

    state.children.forEach((child, i) => {
      const row = document.createElement("div");
      row.className = "bd-child" + (child.on ? "" : " off");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = child.on;
      box.onchange = () => {
        state = toggleChild(state, i);
        render();
      };
      row.appendChild(box);
      const text = document.createElement("input");
      text.type = "text";
      text.value = child.text;
      text.oninput = () => {
        state = editChild(state, i, text.value);
      };
      row.appendChild(text);
      sheet.appendChild(row);
    });

    if (state.reason) {
      const r = document.createElement("div");
      r.className = "bd-reason";
      r.textContent = state.reason;
      sheet.appendChild(r);
    }

    const foot = document.createElement("div");
    foot.className = "bd-foot";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "bd-cancel";
    cancel.textContent = "취소";
    cancel.onclick = close;
    foot.appendChild(cancel);
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "qa-submit";
    apply.textContent = "적용";
    apply.disabled = !hasAnythingToApply(state);
    apply.onclick = () => {
      opts.onApply(state.title, acceptedChildren(state));
      close();
    };
    foot.appendChild(apply);
    sheet.appendChild(foot);
  }

  render();
  opts.host.appendChild(overlay);
  return { close };
}
```

`.btn-ghost`가 `app.css`에 없으면 취소 버튼에 기존 보조 버튼 클래스를 쓴다 —
`app.css`에서 실제로 있는 이름을 찾아 맞춘다.

- [ ] **Step 4: 확인한다**

Run: `pnpm test && npx tsc --noEmit && pnpm build`
Expected: 전부 통과

- [ ] **Step 5: 커밋**

```bash
git add src/quickadd/index.html src/quickadd/breakdownSheet.ts src/shared/app.css
git commit -m "feat: AI 제안 시트 UI를 추가한다"
```

---

### Task 8: 빠른 추가에 배선

**Files:**
- Modify: `src/quickadd/main.ts`

- [ ] **Step 1: 버튼과 상태를 잇는다**

`src/quickadd/main.ts` 상단 import에 더한다:

```ts
import { suggestBreakdown, createIssueTree } from "../shared/ipc";
import { openBreakdownSheet } from "./breakdownSheet";
```

푸터 요소를 잡는 줄 근처(`const qaSubmit = ...`)에 더한다:

```ts
const aiBtn = footer.querySelector<HTMLButtonElement>("#qaAiBtn")!;
```

모듈 전역에 더한다:

```ts
// AI가 제안한 하위 작업. 적용하면 채워지고, 등록하거나 폼을 비우면 사라진다.
let pendingChildren: string[] = [];
```

버튼 핸들러:

```ts
aiBtn.onclick = async () => {
  const title = card.titleValue.trim();
  if (!title) {
    card.markTitleError();
    card.showError("제목을 입력하세요");
    return;
  }
  aiBtn.disabled = true;
  aiBtn.textContent = "✨ 생각 중…";
  try {
    const suggestion = await suggestBreakdown(title, card.descriptionValue);
    openBreakdownSheet({
      host: card.element,
      suggestion,
      originalTitle: title,
      onApply: (newTitle, children) => {
        card.titleValue = newTitle;
        pendingChildren = children;
        renderPendingBadge();
      },
    });
  } catch (err) {
    const msg = String(err);
    card.showError(msg === "no_key" ? "설정에서 OpenAI 키를 먼저 등록하세요" : "AI 제안 실패: " + msg);
  } finally {
    aiBtn.disabled = false;
    aiBtn.textContent = "✨ AI 제안";
  }
};
```

- [ ] **Step 2: 하위 개수 배지를 그린다**

같은 파일에 넣는다:

```ts
/** 적용된 하위 작업이 몇 개인지 버튼 옆에 남긴다 — 시트를 닫은 뒤에도
 *  "쪼개진 상태로 등록된다"는 것이 보여야 한다. */
function renderPendingBadge() {
  aiBtn.textContent = pendingChildren.length > 0 ? `✨ 하위 ${pendingChildren.length}` : "✨ AI 제안";
}
```

- [ ] **Step 3: 등록 경로를 갈라준다**

`submitIssue()`의 `await createIssue(...)` 호출을 다음으로 바꾼다:

```ts
    if (pendingChildren.length > 0) {
      const result = await createIssueTree(
        card.state.selectedId,
        name,
        pendingChildren,
        card.state.assigneeIds,
        resolveDateChoice(card.state.startChoice, card.state.startCustomDate),
        resolveDateChoice(card.state.dueChoice, card.state.dueCustomDate),
        card.state.priority,
        card.state.stateGroup,
        card.descriptionValue,
      );
      if (result.failed.length > 0) {
        // 부모와 일부 자식은 이미 만들어졌다 — 창을 닫지 않고 실패만 알린다.
        card.showError(`하위 ${result.failed.length}개를 만들지 못했습니다: ${result.failed.join(", ")}`);
        pendingChildren = result.failed;
        renderPendingBadge();
        return;
      }
    } else {
      await createIssue(
        card.state.selectedId,
        name,
        card.state.assigneeIds,
        resolveDateChoice(card.state.startChoice, card.state.startCustomDate),
        resolveDateChoice(card.state.dueChoice, card.state.dueCustomDate),
        card.state.priority,
        card.state.stateGroup,
        card.descriptionValue,
      );
    }
```

`return` 앞뒤로 `submitting = false`가 `finally`에서 풀리는지 확인한다 — 기존
구조가 `finally { submitting = false; }`이므로 그대로 두면 된다.

- [ ] **Step 4: 폼을 비울 때 하위도 비운다**

`resetFields()` 안에 더한다:

```ts
  pendingChildren = [];
  renderPendingBadge();
```

- [ ] **Step 5: 확인한다**

Run: `pnpm test && npx tsc --noEmit && pnpm build`
Expected: 전부 통과

수동 확인: 빠른 추가(Shift+F1)에 "홍익대 취약점 문서 확인 및 조치일정 담당자에게
메일 전달"을 넣고 `[✨ AI 제안]`을 누른다. 시트가 카드 위에 뜨고, 제목 비교 줄과
하위 목록이 보이고, 체크를 끄면 취소선이 그어지고, 적용하면 제목이 폼에 반영되며
버튼이 `✨ 하위 N`으로 바뀌어야 한다. Ctrl+Enter로 등록한 뒤 사이드바에서 계층이
보이는지 확인한다.

- [ ] **Step 6: 커밋**

```bash
git add src/quickadd/main.ts
git commit -m "feat: 빠른 추가에서 AI 제안을 받아 상위·하위로 등록한다"
```

---

### Task 9: CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: `[Unreleased] ### 추가`에 한 줄 더한다**

```markdown
- 빠른 추가에서 ✨ AI 제안을 누르면 적어 둔 한 줄을 AI가 검토합니다 — 제목이 어설프면 다듬고, 여러 작업이 섞여 있으면 상위 작업과 하위 작업으로 쪼개 제안합니다. 체크로 빼거나 글자를 고친 뒤 적용하면 폼에 반영되고, 등록은 평소처럼 Ctrl+Enter입니다 (설정의 OpenAI 키를 그대로 씁니다)
```

- [ ] **Step 2: 커밋**

```bash
git add CHANGELOG.md
git commit -m "docs: AI 작업 분해를 변경 내역에 적는다"
```

---

## 완료 확인

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` 전부 통과
- [ ] `pnpm test` 전부 통과
- [ ] `npx tsc --noEmit` 에러 없음
- [ ] `pnpm build` 성공
- [ ] 수동: 여러 작업이 섞인 한 줄 → AI 제안 → 시트에 상위+하위가 뜬다
- [ ] 수동: 이미 잘 쓴 한 줄 → "지금 이대로 충분합니다"가 뜬다
- [ ] 수동: 적용 후 Ctrl+Enter → 사이드바에 계층으로 보인다
- [ ] 수동: OpenAI 키가 없을 때 설정 안내 문구가 뜬다
- [ ] 수동: Esc로 시트를 닫으면 폼이 그대로 남는다

## 범위 밖

- **기존 이슈를 AI로 쪼개기** — 사이드바 항목을 골라 분해하는 경로. 수동 하위
  추가로 같은 일을 할 수 있고, 진입점이 늘면 검토 UI를 QuickAdd 밖으로 꺼내야 한다.
- **AI가 날짜·담당자를 정하기** — 자식은 폼 값을 그대로 물려받는다. 스펙의 결정 2.
- **오프라인 지원** — AI 호출에 네트워크가 필요하므로 버튼이 실패하는 것이 정상이다.
  수동 하위 추가는 1단계에서 이미 오프라인에서 동작한다.
