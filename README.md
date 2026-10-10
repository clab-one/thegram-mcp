# thegram-memory

Thegram을 코딩 에이전트의 영구 프로젝트 메모리로 쓰게 하는 플러그인이다. 저장소 하나가 Claude Code, Codex, opencode(v1·v2)와 OMP의 플러그인으로 동작한다. Thegram MCP 연결, 메모리 주입 훅, 기록 정책과 `thegram-memory` 스킬을 함께 설치한다.

## 동작

| 구성 | 내용 |
|---|---|
| MCP | `thegram` 서버. `dist/thegram-memory.mjs mcp`가 stdio MCP를 Thegram 앱의 unix socket(`~/Library/Application Support/Thegram/mcp.json`의 `socket`)으로 전달한다. |
| 읽기 주입 | 세션 시작과 압축 직후에 기록 정책과 프로젝트 brief를 넣는다. 첫 실질 프롬프트에는 `gram_recall` 결과를 넣고, 이후 프롬프트에는 다른 작성자의 변경만 넣는다. |
| 쓰기 리마인더 | 한 턴에서 파일 편집이 3회 이상이거나 git commit이 있고 Thegram 쓰기가 없으면 한 번 알린다. 쓰기는 메인 에이전트가 `gram_patch`로 한다. 서브에이전트에는 리마인더를 넣지 않는다. |
| 정책 | `policy.md`. 사용자별 규칙은 `~/.config/thegram-memory/policy.md`에 쓰면 모든 에이전트에서 정책 뒤에 붙는다. |
| 스킬 | `skills/thegram-memory`. 도구 호출 형식, 기록 어휘, 오류 코드, 앱이 그리는 대시보드·Mermaid 규칙과 이력 backfill 절차(`backfill.md`)를 담는다. |
| 앱이 없을 때 | 안내 한 줄만 넣고 세션은 계속한다. MCP 호출은 JSON-RPC 오류로 답한다. |

| 에이전트 | 읽는 경로 |
|---|---|
| Claude Code | `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `skills/` |
| Codex | `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json`(Codex는 MCP 인자의 `${CLAUDE_PLUGIN_ROOT}`를 풀지 않는다), `hooks/hooks.json`, `skills/`. 훅은 `hooks` 기능과 사용자 trust가 필요하다. |
| OMP | marketplace 설치: `skills/`, `.mcp.json`, `package.json#omp.extensions`(`src/omp.ts`) |
| opencode | `package.json#exports`(`src/opencode.ts`). 기본 export 하나로 v2 `setup()`과 v1 `server()`를 제공하고, MCP와 스킬을 스스로 등록한다. |

## 요구 사항

- macOS의 Thegram 앱. 에이전트 접근을 쓰기로 둔다.
- Node 22 이상(`node`가 PATH에 있어야 한다). 훅과 MCP 서버가 `dist/thegram-memory.mjs`를 node로 실행한다.
- 이 저장소는 private이다. 설치에는 `clab-one` 저장소를 읽을 수 있는 git 인증이 필요하다.

## 설치

```sh
# Claude Code
claude plugin marketplace add clab-one/thegram-memory
claude plugin install thegram-memory@thegram-memory

# Codex: 설치 뒤 첫 실행에서 "Trust all and continue"로 훅을 승인한다.
codex features enable hooks
codex plugin marketplace add clab-one/thegram-memory
codex plugin add thegram-memory@thegram-memory

# OMP
omp plugin marketplace add clab-one/thegram-memory
omp plugin install thegram-memory@thegram-memory

# opencode v2
opencode plugin add github:clab-one/thegram-memory
```

opencode v1은 `opencode.json`의 `plugin` 배열에 `github:clab-one/thegram-memory`를 넣는다. 같은 이름의 MCP 서버를 이미 수동으로 등록했다면 지운다. 설치 뒤에는 새 세션을 연다.

## 프로젝트 매핑

git 저장소는 common dir 기준 저장소 이름과 같은 볼트 폴더에 연결된다. worktree는 원래 저장소의 폴더를 공유한다. 앱은 점으로 시작하는 폴더를 프로젝트 목록에서 숨긴다. 그래서 `.dotfiles` 같은 저장소는 앞의 점을 뗀 `dotfiles` 폴더에 연결된다. 예외는 `~/.config/thegram-memory/projects.json`에 디렉터리 접두사로 적는다. 가장 긴 접두사가 이긴다.

```json
{
	"~/.omp": "omp"
}
```

git 저장소도 아니고 매핑도 없는 디렉터리에서는 아무것도 주입하지 않는다.

## 점검

```sh
node dist/thegram-memory.mjs doctor [dir]
```

앱 연결, 볼트, 디렉터리의 프로젝트 폴더, 로컬 설정과 훅 상태 경로를 보여 준다. 앱에 닿지 못하면 종료 코드 1이다.

## 개발

```sh
bun run bundle  # src → dist/thegram-memory.mjs. dist는 커밋한다. 설치는 빌드하지 않고, `build`·`prepare` 같은 스크립트가 있으면 npm의 git 설치가 저장소 안에서 npm install을 돌리다 opencode에서 실패한다.
bun run check   # 로컬 oh-my-pi 체크아웃 타입으로 검사
bun run e2e [claude codex opencode opencode1 omp] [--installed] [--keep]
```

E2E는 에이전트마다 임시 git 저장소와 같은 이름의 볼트 폴더를 만든다. 결정 하나를 심은 뒤 두 가지를 확인한다. 하나는 도구 없이 주입된 메모리만으로 그 결정 id를 답하는지다. 다른 하나는 Thegram을 언급하지 않은 코딩 작업 뒤 에이전트가 스스로 Thegram에 기록하는지다. 결과는 `e2e/artifacts/*.json`에 남고 임시 폴더는 실패해도 지운다. `--installed`는 `--plugin-dir`·로컬 경로 없이 설치된 플러그인으로 실행한다. Codex는 언제나 플러그인 캐시의 사본을 실행한다. 그래서 dev 실행은 캐시와 작업 트리의 런타임 파일 해시가 다르면 시작하지 않는다. Claude dev 실행은 marketplace 설치본이 있으면 시작하지 않는다. 에이전트가 이 저장소의 HEAD나 파일을 바꾸면 하네스는 그 자리에서 멈춘다. Codex 실행은 훅 trust 화면에 답할 수 없어 `--dangerously-bypass-hook-trust`를 쓴다.

## 제한

- Thegram 앱 공식 release는 아직 막혀 있다(`thegram-desktop` README). 앱이 없으면 이 플러그인은 안내만 한다.
- `gram_profile {task: "memory"}`에는 add 연산 형식이 없다. 그래서 정책과 리마인더에 검증된 형식을 적었다.
- Thegram은 정해진 필드 키 외에는 `E_FIELD`로 거부한다.
- 시맨틱 recall에는 관련도 하한이 없다. 그래서 recall은 brief 뒤 첫 실질 프롬프트에만 한다.
- 이름이 같은 서로 다른 저장소(`~/a/api`, `~/b/api`)는 같은 볼트 폴더를 쓴다. 섞이면 안 되면 `projects.json`으로 나눈다.
- MCP 프록시는 세션 기반(legacy) Streamable HTTP만 중계한다. 2026-07-28 stateless 모드를 켠 클라이언트는 앱에서 거부될 수 있다.
