use std::io::BufRead;
// Reads one JS-printed number per line, parses it exactly as core4 does (serde_json
// Value, float_roundtrip OFF), re-prints it with serde_json::to_string, one per line.
fn main() {
    for line in std::io::stdin().lock().lines() {
        let s = line.unwrap();
        let v: serde_json::Value = serde_json::from_str(&format!("{{\"x\":{}}}", s)).unwrap();
        println!("{}", serde_json::to_string(&v["x"]).unwrap());
    }
}
