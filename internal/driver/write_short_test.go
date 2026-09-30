package driver

import (
	"strings"
	"testing"
)

func updateSetting(v any) Change {
	return Change{
		Op:  ChangeUpdate,
		Set: []Assignment{{Column: "doc", Value: v}},
		Key: []KeyCond{{Column: "id", Value: int64(1)}},
	}
}

func TestShortLeavesShortValuesAlone(t *testing.T) {
	for _, kind := range []Kind{KindMySQL, KindPostgres, KindMSSQL, KindSQLite} {
		st, err := mustGet(t, kind).BuildChange(writeRef, updateSetting(strings.Repeat("a", ShortLiteralChars)))
		if err != nil {
			t.Fatal(err)
		}
		if st.Short != st.Display {
			t.Errorf("%s: a value at the limit was cut\n%s", kind, st.Short)
		}
	}
}

func TestShortCutsLongValuesAndCountsTheRest(t *testing.T) {
	long := strings.Repeat("a", ShortLiteralChars+4000)
	st, err := mustGet(t, KindPostgres).BuildChange(writeRef, updateSetting(long))
	if err != nil {
		t.Fatal(err)
	}
	want := `UPDATE "sales"."orders" SET "doc" = '` + strings.Repeat("a", ShortLiteralChars) + `…(+4000 more chars)' WHERE "id" = 1`
	if st.Short != want {
		t.Errorf("Short\n got %s\nwant %s", st.Short, want)
	}
	if !strings.Contains(st.Display, long) {
		t.Error("Display must keep the full literal")
	}
	if len(st.Args) != 2 || st.Args[0] != long {
		t.Error("the bound value must be untouched")
	}
}

func TestShortCountsRunesNotBytes(t *testing.T) {
	long := strings.Repeat("é", ShortLiteralChars) + "日本語"
	st, err := mustGet(t, KindSQLite).BuildChange(writeRef, updateSetting(long))
	if err != nil {
		t.Fatal(err)
	}
	want := `'` + strings.Repeat("é", ShortLiteralChars) + `…(+3 more chars)'`
	if !strings.Contains(st.Short, want) {
		t.Errorf("Short = %s, want it to contain %s", st.Short, want)
	}
}

// The cut is made before quoting, so a quote or backslash at the boundary is
// doubled whole or left out whole, never split.
func TestShortQuotingNearTheCut(t *testing.T) {
	long := strings.Repeat("a", ShortLiteralChars-1) + `'` + `\` + "tail"
	cases := []struct {
		kind Kind
		head string
	}{
		{KindSQLite, strings.Repeat("a", ShortLiteralChars-1) + `''`},
		{KindMySQL, strings.Repeat("a", ShortLiteralChars-1) + `''`},
		{KindMSSQL, strings.Repeat("a", ShortLiteralChars-1) + `''`},
	}
	for _, c := range cases {
		st, err := mustGet(t, c.kind).BuildChange(writeRef, updateSetting(long))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(st.Short, c.head+`…(+5 more chars)'`) {
			t.Errorf("%s: quote at the cut was split: %s", c.kind, st.Short)
		}
	}

	// The same boundary one rune later takes the backslash, which MySQL doubles.
	long = strings.Repeat("a", ShortLiteralChars-1) + `\` + "tail"
	st, _ := mustGet(t, KindMySQL).BuildChange(writeRef, updateSetting(long))
	if !strings.Contains(st.Short, strings.Repeat("a", ShortLiteralChars-1)+`\\…(+4 more chars)'`) {
		t.Errorf("mysql backslash at the cut: %s", st.Short)
	}
}

func TestShortKeepsNullDefaultAndNumbersAsTheyAre(t *testing.T) {
	ch := Change{
		Op: ChangeUpdate,
		Set: []Assignment{
			{Column: "a", Value: nil},
			{Column: "b", Default: true},
			{Column: "c", Value: int64(5)},
			{Column: "d", Value: strings.Repeat("x", 500)},
		},
		Key: []KeyCond{{Column: "id", Value: int64(1)}},
	}
	st, err := mustGet(t, KindPostgres).BuildChange(writeRef, ch)
	if err != nil {
		t.Fatal(err)
	}
	want := `UPDATE "sales"."orders" SET "a" = NULL, "b" = DEFAULT, "c" = 5, "d" = '` +
		strings.Repeat("x", ShortLiteralChars) + `…(+340 more chars)' WHERE "id" = 1`
	if st.Short != want {
		t.Errorf("Short\n got %s\nwant %s", st.Short, want)
	}
}
