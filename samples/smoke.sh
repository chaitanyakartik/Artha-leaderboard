#!/usr/bin/env bash
# End-to-end smoke test. Usage: bash samples/smoke.sh [port]
set -e
P="${1:-5181}"
B="http://localhost:$P"
J=$(mktemp)
jq() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

login() { curl -s -c "$J" -X POST "$B/api/login" -H 'content-type: application/json' \
  -d '{"username":"chaitu","password":"changeme-artha"}' >/dev/null; }
post() { curl -s -b "$J" -X POST "$B$1" -H 'content-type: application/json' -d "$2"; }
get()  { curl -s -b "$J" "$B$1"; }

login
echo "== model cards =="
get /api/models | python3 -c 'import sys,json;[print("  ",m["id"],"->",m["card"]["kind"],m["card"]["tasks"]) for m in json.load(sys.stdin)]'

DSID=$(post /api/datasets '{"name":"V1","n_applicants":2,"n_docs":7}' | jq 'd["id"]')
echo "== dataset id=$DSID =="

post "/api/datasets/$DSID/gt" '{"task":"classification","gt":{"a":"aadhaar","b":"pan","c":"bank_statement"}}' >/dev/null
echo "== classification, MESSY casing/spaces (expect accuracy 1.0) =="
post /api/runs '{"task":"classification","dataset_id":'"$DSID"',"model_config_id":"chandra-only","predictions":{"a":"Aadhaar","b":"  PAN ","c":"Bank_Statement"}}' \
  | jq '"accuracy="+str(d["headline"]["value"])+"  run="+d["display_name"]'

echo "== coverage gate (missing c -> 422) =="
post /api/runs '{"task":"classification","dataset_id":'"$DSID"',"model_config_id":"gemini-only","predictions":{"a":"aadhaar","b":"pan"}}' \
  | jq '"code="+d["error"]+" missing="+str(d["missing"])'

echo "== segmentation (per-page start/continue+class), headline=recall, one missed boundary =="
post "/api/datasets/$DSID/gt" '{"task":"segmentation","gt":{"bundleA":[{"page":1,"tag":"start","class":"aadhaar"},{"page":2,"tag":"continue","class":"aadhaar"},{"page":3,"tag":"start","class":"pan"},{"page":4,"tag":"start","class":"bank_statement"}]}}' >/dev/null
SEG=$(post /api/runs '{"task":"segmentation","dataset_id":'"$DSID"',"model_config_id":"gemini-only","predictions":{"bundleA":[{"page":1,"tag":"start","class":"aadhaar"},{"page":2,"tag":"continue","class":"aadhaar"},{"page":3,"tag":"continue","class":"aadhaar"},{"page":4,"tag":"start","class":"bank_statement"}]}}')
echo "$SEG" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("  headline="+d["headline"]["key"]+"="+str(d["headline"]["value"]));m=d["analysis"]["transitions"]["merges"];print("  top merge:",m[0]["from"],"->",m[0]["to"],"x",m[0]["count"]) if m else print("  no merges")'
SEGID=$(echo "$SEG" | jq 'd["run_id"]')

echo "== event store: per-page events persisted for re-aggregation =="
get "/api/runs/$SEGID/events" | jq '"  events stored="+str(d["total"])'
echo "== re-aggregate from stored events (no re-score) =="
post "/api/runs/$SEGID/reaggregate" '{}' | jq '"  reaggregated ok, findings="+str(len(d["analysis"]["overview"]["key_findings"]))'

echo "== W&B ingest gated OFF (expect 501) =="
curl -s -b "$J" -o /dev/null -w "status=%{http_code}\n" -X POST "$B/api/ingest/wandb" -H 'content-type: application/json' -d '{}'

echo "== dedup: two runs, same model+dataset -> distinct run_keys =="
get "/api/leaderboard?task=classification&dataset_id=$DSID" | jq '"runs="+str([r["run_key"] for r in d])'

echo "== rename a run =="
RID=$(get "/api/leaderboard?task=segmentation&dataset_id=$DSID" | jq 'd[0]["id"]')
curl -s -b "$J" -X PATCH "$B/api/runs/$RID" -H 'content-type: application/json' -d '{"display_name":"seg-baseline-renamed"}' >/dev/null
get "/api/leaderboard?task=segmentation&dataset_id=$DSID" | jq '"renamed_to="+d[0]["display_name"]'
