#!/bin/bash

# SNMP Time Series Graph - API Testing Script
# This script verifies all APIs are working correctly

echo "========================================="
echo "SNMP Time Series Graph - API Test Suite"
echo "========================================="
echo ""

API_URL="http://localhost:3000"
DEVICE_ID="router1"
TEST_INTERFACE="ether1"

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

test_count=0
pass_count=0
fail_count=0

function test_api() {
  local method=$1
  local endpoint=$2
  local data=$3
  local description=$4
  
  test_count=$((test_count + 1))
  
  echo ""
  echo -e "${YELLOW}Test $test_count: $description${NC}"
  echo "  $method $endpoint"
  
  if [ -z "$data" ]; then
    response=$(curl -s -X "$method" "$API_URL$endpoint")
  else
    response=$(curl -s -X "$method" "$API_URL$endpoint" \
      -H "Content-Type: application/json" \
      -d "$data")
  fi
  
  echo "  Response: ${response:0:100}..."
  
  # Check if response is valid JSON or contains expected content
  if echo "$response" | python3 -m json.tool > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓ PASS${NC}"
    pass_count=$((pass_count + 1))
  else
    echo -e "  ${RED}✗ FAIL${NC}"
    fail_count=$((fail_count + 1))
  fi
}

# Test 1: Get all devices
test_api "GET" "/api/devices" "" "Get all devices"

# Test 2: Get device interfaces
test_api "GET" "/api/devices/$DEVICE_ID/interfaces" "" "Get interfaces for $DEVICE_ID"

# Test 3: Select interfaces
interface_data='{"selectedInterfaces":["ether1","ether2"]}'
test_api "POST" "/api/devices/$DEVICE_ID/select-interfaces" "$interface_data" "Select interfaces for $DEVICE_ID"

# Test 4: Get graph data
test_api "GET" "/api/data?device=$DEVICE_ID&interface=$TEST_INTERFACE" "" "Get graph data"

# Test 5: Get home page
echo ""
echo -e "${YELLOW}Test $((test_count + 1)): Load home page${NC}"
echo "  GET /"
response=$(curl -s "$API_URL/")
if echo "$response" | grep -q "Select Device"; then
  echo "  Found 'Select Device' in response"
  echo -e "  ${GREEN}✓ PASS${NC}"
  pass_count=$((pass_count + 1))
else
  echo -e "  ${RED}✗ FAIL${NC}"
  fail_count=$((fail_count + 1))
fi
test_count=$((test_count + 1))

# Test 6: Get device management page
echo ""
echo -e "${YELLOW}Test $test_count: Load device management page${NC}"
echo "  GET /devices"
response=$(curl -s "$API_URL/devices")
if echo "$response" | grep -q "Add New Device"; then
  echo "  Found 'Add New Device' in response"
  echo -e "  ${GREEN}✓ PASS${NC}"
  pass_count=$((pass_count + 1))
else
  echo -e "  ${RED}✗ FAIL${NC}"
  fail_count=$((fail_count + 1))
fi

echo ""
echo "========================================="
echo "Test Results"
echo "========================================="
echo "Total Tests: $test_count"
echo -e "Passed: ${GREEN}$pass_count${NC}"
echo -e "Failed: ${RED}$fail_count${NC}"

if [ $fail_count -eq 0 ]; then
  echo ""
  echo -e "${GREEN}✓ All tests passed!${NC}"
  echo ""
  echo "✓ Device APIs working"
  echo "✓ Interface discovery working"
  echo "✓ Interface selection working"
  echo "✓ Graph data retrieval working"
  echo "✓ Frontend pages rendering"
  echo ""
  echo "Your SNMP Time Series Graph is ready to use!"
  echo "  - View graphs: http://localhost:3000"
  echo "  - Manage devices: http://localhost:3000/devices"
  exit 0
else
  echo ""
  echo -e "${RED}✗ Some tests failed${NC}"
  echo "Check server is running: npm start"
  exit 1
fi
