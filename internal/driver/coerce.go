package driver

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Turning what the grid sends into something a database will bind.
//
// A cell arrives as text and a key arrives in the wire format ReadRows produced
// (scan.go), both untyped. Coercion is by the column's declared type, and small
// on purpose: only the types where the wrong Go type changes the meaning are
// converted. Everything else — text, json, dates, decimals — goes through as the
// string it was, for the database to parse, which is the parser that knows.

type typeClass int

const (
	classText typeClass = iota // bound as the string it arrived as
	classBool
	classInt
	classFloat
	classDecimal // kept as text: a float64 would lose digits, see scan.go
)

func classify(dataType string) typeClass {
	base, arg, _ := splitTypeArg(dataType)
	// "BIGINT UNSIGNED" and "DOUBLE PRECISION" are decided by their first word.
	word, _, _ := strings.Cut(base, " ")
	switch word {
	case "BOOL", "BOOLEAN":
		return classBool
	case "BIT":
		// MySQL bit(8) is a bit string rather than a flag.
		if arg == "" || arg == "1" {
			return classBool
		}
	case "TINYINT", "SMALLINT", "MEDIUMINT", "INT", "INTEGER", "BIGINT",
		"INT2", "INT4", "INT8", "SERIAL", "SMALLSERIAL", "BIGSERIAL":
		return classInt
	case "FLOAT", "DOUBLE", "REAL", "FLOAT4", "FLOAT8":
		return classFloat
	case "DECIMAL", "NUMERIC", "DEC":
		return classDecimal
	}
	return classText
}

var decimalRE = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// CoerceValue converts text typed into a cell. The error names the column, since
// it is shown next to a whole change set.
func CoerceValue(col Column, s string) (any, error) {
	v, err := coerceString(classify(col.DataType), s)
	if err != nil {
		return nil, fmt.Errorf("column %q: %w", col.Name, err)
	}
	return v, nil
}

func coerceString(class typeClass, s string) (any, error) {
	t := strings.TrimSpace(s)
	switch class {
	case classBool:
		switch strings.ToLower(t) {
		case "true", "t", "1", "yes", "y", "on":
			return true, nil
		case "false", "f", "0", "no", "n", "off":
			return false, nil
		}
		return nil, fmt.Errorf("%q is not true or false", s)

	case classInt:
		// MySQL's tinyint(1) is its boolean, and people will type the word.
		switch strings.ToLower(t) {
		case "true":
			return int64(1), nil
		case "false":
			return int64(0), nil
		}
		if n, err := strconv.ParseInt(t, 10, 64); err == nil {
			return n, nil
		}
		// An unsigned bigint past int64 cannot be a driver.Value as a number;
		// the database parses the digits instead.
		if _, err := strconv.ParseUint(t, 10, 64); err == nil {
			return t, nil
		}
		return nil, fmt.Errorf("%q is not a whole number", s)

	case classFloat:
		f, err := strconv.ParseFloat(t, 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, fmt.Errorf("%q is not a finite number", s)
		}
		return f, nil

	case classDecimal:
		if !decimalRE.MatchString(t) {
			return nil, fmt.Errorf("%q is not a number", s)
		}
		return t, nil
	}
	return s, nil
}

// CoerceKey converts a key value as ReadRows sent it. Numbers below 2^53 are JSON
// numbers and arrive as float64; bigints, decimals, dates and text arrive as
// strings. A NULL is refused: no row is ever found by `= NULL`.
func CoerceKey(col Column, v any) (any, error) {
	class := classify(col.DataType)
	switch x := v.(type) {
	case nil:
		return nil, fmt.Errorf("key column %q is NULL", col.Name)
	case string:
		return CoerceValue(col, x)
	case bool:
		switch class {
		case classBool:
			return x, nil
		case classInt:
			if x {
				return int64(1), nil
			}
			return int64(0), nil
		}
	case float64:
		switch class {
		case classInt:
			if x == math.Trunc(x) && math.Abs(x) <= 1<<53 {
				return int64(x), nil
			}
			return nil, fmt.Errorf("column %q: %v is not a whole number", col.Name, x)
		case classFloat:
			return x, nil
		case classBool:
			if x == 0 || x == 1 {
				return x == 1, nil
			}
		default:
			return strconv.FormatFloat(x, 'f', -1, 64), nil
		}
	}
	return nil, fmt.Errorf("column %q: cannot use %v (%T) as a key value", col.Name, v, v)
}
