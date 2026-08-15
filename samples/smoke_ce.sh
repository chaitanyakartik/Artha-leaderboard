#!/usr/bin/env bash
# Classification + Extraction + Prompts smoke. Usage: bash samples/smoke_ce.sh [port]
# Run against a server on a FRESH db (npm run db:init). Imports the sample taxonomies first, so the
# classifier profile + extraction template have something to reference.
set -e
P="${1:-5186}"; B="http://localhost:$P"; J=$(mktemp)
py(){ python3 -c "$1"; }
login(){ curl -s -c "$J" -X POST "$B/api/login" -H 'content-type: application/json' -d '{"username":"chaitu","password":"changeme-artha"}' >/dev/null; }
post(){ curl -s -b "$J" -X POST "$B$1" -H 'content-type: application/json' -d "$2"; }
get(){ curl -s -b "$J" "$B$1"; }

echo "== import sample taxonomies =="
node scripts/import-classes.js samples/classes.sample.json
node scripts/import-extraction-types.js samples/extraction-types.sample.json

login
DSID=$(post /api/datasets '{"name":"CE","n_docs":6}' | py 'import sys,json;print(json.load(sys.stdin)["id"])')

echo "== CLASSIFICATION: enabled-subset profile, out-of-scope class, per-class + confusion =="
PID=$(post /api/classifier-profiles '{"name":"kyc+fin","classes":["aadhaar","pan","bank_statement","salary_slip"]}' | py 'import sys,json;print(json.load(sys.stdin)["id"])')
CP=$(post /api/prompts '{"task":"classification","name":"cls-basic","version":"v1","text":"Classify the doc."}' | py 'import sys,json;print(json.load(sys.stdin)["id"])')
post "/api/datasets/$DSID/gt" '{"task":"classification","gt":{"d1":"aadhaar","d2":"pan","d3":"bank_statement","d4":"bank_statement","d5":"salary_slip","d6":"itr"}}' >/dev/null
CID=$(post /api/runs '{"task":"classification","dataset_id":'"$DSID"',"model_config_id":"gemini-only","profile_id":'"$PID"',"prompt_id":'"$CP"',"predictions":{"d1":"aadhaar","d2":"aadhaar","d3":"bank_statement","d4":"salary_slip","d5":"salary_slip","d6":"itr"}}' | py 'import sys,json;print(json.load(sys.stdin)["run_id"])')
get "/api/runs/$CID" | py '
import sys,json;r=json.load(sys.stdin);a=r["analysis"]
assert a["overview"]["n_out_of_scope"]==1, a["overview"]
assert a["enabled"]["count"]==4 and a["disabled"]["count"]==3, (a["enabled"],a["disabled"])
print("  accuracy=%s macro_f1=%s enabled=%d/%d disabled=%s prompt=%s"%(a["accuracy"],a["macro_f1"],a["enabled"]["count"],a["enabled"]["master_count"],a["disabled"]["classes"],r["prompt_name"]))
print("  worst class:",a["per_class"][0]["class"],"F1",a["per_class"][0]["f1"])'

echo "== EXTRACTION: template, field support, macro vs micro, char-sim =="
ETID=$(get "/api/extraction-types" | py 'import sys,json;print([t["id"] for t in json.load(sys.stdin) if t["name"]=="rent_agreement"][0])')
post "/api/datasets/$DSID/gt" '{"task":"extraction","gt":{"r1":{"tenant_name":"Ravi Kumar","landlord_name":"S. Rao","monthly_rent":"12,500","start_date":"01/04/2024"},"r2":{"tenant_name":"Asha Devi","monthly_rent":"9000","deposit":"18000"},"r3":{"tenant_name":"Ken","landlord_name":"Mehta","monthly_rent":"15000","start_date":"2024-06-01","deposit":"30000"}}}' >/dev/null
EID=$(post /api/runs '{"task":"extraction","dataset_id":'"$DSID"',"model_config_id":"gemini-only","extraction_type_id":'"$ETID"',"predictions":{"r1":{"tenant_name":"Ravi Kumar","landlord_name":"S Rao","monthly_rent":"Rs 12500","start_date":"2024-04-01"},"r2":{"tenant_name":"Aasha Devi","monthly_rent":"9000","deposit":"18000"},"r3":{"tenant_name":"Ken","landlord_name":"Mehta","monthly_rent":"15000","start_date":"2024-06-01","deposit":"30,000"}}}' | py 'import sys,json;print(json.load(sys.stdin)["run_id"])')
get "/api/runs/$EID" | py '
import sys,json;a=json.load(sys.stdin)["analysis"]
fields={f["field"]:f for f in a["per_field"]}
assert fields["landlord_name"]["support"]==2 and fields["tenant_name"]["support"]==3, fields
assert a["macro_field_accuracy"]!=a["field_accuracy"], "macro should differ from micro here"
print("  micro=%s macro=%s micro_charsim=%s doc_exact=%s"%(a["field_accuracy"],a["macro_field_accuracy"],a["micro_char_sim"],a["doc_exact_match"]))
print("  supports:",{k:v["support"] for k,v in fields.items()})'

echo "== RE-AGGREGATE both from item_results (no re-score) =="
post "/api/runs/$CID/reaggregate" '{}' | py 'import sys,json;a=json.load(sys.stdin)["analysis"];print("  cls: accuracy=%s enabled=%d/%d"%(a["accuracy"],a["enabled"]["count"],a["enabled"]["master_count"]))'
post "/api/runs/$EID/reaggregate" '{}' | py 'import sys,json;a=json.load(sys.stdin)["analysis"];print("  ext: micro=%s macro=%s"%(a["field_accuracy"],a["macro_field_accuracy"]))'
echo "ALL CE CHECKS PASSED"
