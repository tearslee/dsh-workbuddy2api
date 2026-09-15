// 用**真实的 Go 实现** `session.TurnKey` / `session.TurnRequestID` 校验适配器产出的请求体。
//
// 这是端到端证据：`tests/unit/turn-key-contract.spec.ts` 里的取键函数是按 Go 源码
// 同构重写的，只能证明「规则自洽」；本工具直接调用上游 Go 代码，证明「这就是网关
// 真正在跑的逻辑」。
//
// 该工具**不属于上游项目**。因为 Go 的 `internal/` 包不能被外部模块导入
// （`replace` 也不行，会报 `use of internal package ... not allowed`），
// 所以用法是**拷贝进 clone 里跑，跑完即删**：
//
//   cp -r tools/turnkey-verify/turncheck <clone>/internal/session/turncheck
//   cd <clone> && go run ./internal/session/turncheck -bodies <abs>/turn-bodies.json
//   rm -rf <clone>/internal/session/turncheck
//
// 详见本目录 README.md。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"workbuddy2api/internal/session"
)

type sample struct {
	Name string          `json:"name"`
	Body json.RawMessage `json:"body"`
}

func main() {
	bodies := flag.String("bodies", "", "path to turn-bodies.json")
	flag.Parse()
	if *bodies == "" {
		fmt.Fprintln(os.Stderr, "usage: -bodies <path>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(*bodies)
	if err != nil {
		fmt.Fprintln(os.Stderr, "read:", err)
		os.Exit(2)
	}
	var samples []sample
	if err := json.Unmarshal(raw, &samples); err != nil {
		fmt.Fprintln(os.Stderr, "parse:", err)
		os.Exit(2)
	}

	// keys 与 ids 必须分开存：空键时 TurnRequestID 返回**新随机值**（不是空串），
	// 所以断言"是否建立聚合键"要看 keys（TurnKey 的返回值），不能看 ids。
	keys := map[string]string{}
	ids := map[string]string{}
	for _, s := range samples {
		// 复用网关真实入口：TurnKey 取键，TurnRequestID 派生聚合 ID。
		key := session.TurnKey(s.Body)
		id := session.TurnRequestID(key)
		keys[s.Name] = key
		ids[s.Name] = id
		if key == "" {
			fmt.Printf("%-14s key=(空 — 无用户文本，网关回落请求级随机 ID，每次不同)\n", s.Name)
			continue
		}
		fmt.Printf("%-14s key=%-34s id=%s\n", s.Name, key, id)
	}

	fmt.Println()
	type expectation struct {
		label string
		ok    bool
	}
	checks := []expectation{
		{"A 轮三个 step 同键（轮内 tool call 多轮不换键）", keys["A-step1"] != "" && ids["A-step1"] == ids["A-step2"] && ids["A-step2"] == ids["A-step3"]},
		{"B 轮与 A 轮不同键（用户发下一条消息换键）", keys["B-step1"] != "" && ids["B-step1"] != ids["A-step1"]},
		{"C 轮与 A 轮不同键（同样文本但在不同序号）", keys["C-step1"] != "" && ids["C-step1"] != ids["A-step1"]},
		{"多模态用户消息可建键", keys["D-multimodal"] != ""},
		{"无用户文本时不建键（不伪造聚合键）", keys["E-no-user"] == ""},
	}
	failed := 0
	for _, c := range checks {
		mark := "PASS"
		if !c.ok {
			mark = "FAIL"
			failed++
		}
		fmt.Printf("  [%s] %s\n", mark, c.label)
	}
	if failed > 0 {
		fmt.Printf("\n%d 项失败\n", failed)
		os.Exit(1)
	}
	fmt.Println("\n全部通过 —— 适配器产出的请求体在真实 Go 实现下产生稳定的轮级聚合键。")
}
