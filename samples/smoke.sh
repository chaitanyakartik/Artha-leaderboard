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

echo "== segmentation, headline=recall, one missed boundary =="
post "/api/datasets/$DSID/gt" '{"task":"segmentation","gt":{"bundle1":[[1,3],[4,6],[7,9]]}}' >/dev/null
post /api/runs '{"task":"segmentation","dataset_id":'"$DSID"',"model_config_id":"gemini-only","predictions":{"bundle1":[[1,6],[7,9]]}}' \
  | jq '"headline="+d["headline"]["key"]+"="+str(d["headline"]["value"])'

echo "== W&B ingest gated OFF (expect 501) =="
curl -s -b "$J" -o /dev/null -w "status=%{http_code}\n" -X POST "$B/api/ingest/wandb" -H 'content-type: application/json' -d '{}'

echo "== dedup: two runs, same model+dataset -> distinct run_keys =="
get "/api/leaderboard?task=classification&dataset_id=$DSID" | jq '"runs="+str([r["run_key"] for r in d])'

echo "== rename a run =="
RID=$(get "/api/leaderboard?task=segmentation&dataset_id=$DSID" | jq 'd[0]["id"]')
curl -s -b "$J" -X PATCH "$B/api/runs/$RID" -H 'content-type: application/json' -d '{"display_name":"seg-baseline-renamed"}' >/dev/null
get "/api/leaderboard?task=segmentation&dataset_id=$DSID" | jq '"renamed_to="+d[0]["display_name"]'
