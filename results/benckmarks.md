# 🔬 Benchmark Results: `nebula`

**Run Date:** 2023-10-27
**Environment:** `fran98m-Z790-UD-AX`
**Command:** `npx tsx scripts/benchmark.ts ~/Documents/nebula/src ~/Documents/nebula/db/migrations`

## 📂 Project Structure

* **Code path:** `/home/fran98m/Documents/nebula/src`
* **Migrations path:** `/home/fran98m/Documents/nebula/db/migrations`
* **Schema state:** 43 tables, 5 enum types
* **Total migration files:** 326

## 💻 TypeScript Analysis

| **Metric** | **RAW (Full Context)** | **COMPACT (YAML Signatures)** | 
| ----- | ----- | ----- | 
| **Total Files** | 821 | 821 | 
| **Characters** | 2,641,737 | 487,376 | 
| **Lines** | 78,508 | 9,373 | 
| **Tokens** | **698,396** | **138,966** | 

### 📉 Compression Efficiency

* **Ratio:** 5.0x smaller
* **Savings:** 80.1%

### ⚠️ Top 10 Most Expensive Files (Raw Tokens)

 1.  — 22,140 tk
 2.  — 14,631 tk
 3.  — 13,320 tk
 4.  — 12,243 tk
 5.  — 10,184 tk
 6.  — 8,881 tk
 7.  — 7,266 tk
 8.  — 7,106 tk
 9.  — 6,984 tk
10.  — 6,981 tk
Actual filenames were deleted this is a private codebase 
## 🗄️ SQL Migration Analysis

| **Metric** | **RAW (Full Context)** | **COMPACT (Schema Only)** | 
| ----- | ----- | ----- | 
| **Total Files** | 326 | 326 | 
| **Characters** | 97,652 | 15,972 | 
| **Lines** | 3,645 | 509 | 
| **Tokens** | **24,965** | **4,564** | 

### 📉 Compression Efficiency

* **Ratio:** 5.5x smaller
* **Savings:** 81.7%

## 🏆 Overall Summary

| **Metric** | **Value** | 
| ----- | ----- | 
| **Raw Total Tokens** | 723,361 | 
| **Compact Total Tokens** | 143,530 | 
| **Overall Compression** | **5.0x** | 
| **Token Savings** | **80.2%** | 

### 🧠 LLM Compatibility Check

* **Claude 3.5 Sonnet (200k):** ✅ (Fits in Compact) | ❌ (Raw too large)
* **GPT-4o (128k):** ❌ (Too large)
* **Standard Context (~8k):** ❌ (Too large)

> **Note:** Even with compact YAML, the project size exceeds the 128k limit. It is recommended to use `full --all-schema --topk N` to selectively include files and stay within token budgets.

---

# 🔬 Benchmark Results: `havok`

**Run Date:** 2023-10-27  
**Environment:** `fran98m-Z790-UD-AX`  
**Command:** `npx tsx scripts/benchmark.ts ~/Documents/Instaleap/havok/src ~/Documents/Instaleap/havok/db/migrations`

## 📂 Project Structure

* **Code path:** `/home/fran98m/Documents/Instaleap/havok/src`
* **Migrations path:** `/home/fran98m/Documents/Instaleap/havok/db/migrations`
* **Schema state:** 12 tables, 0 enum types
* **Total migration files:** 12

## 💻 TypeScript Analysis

| **Metric** | **RAW (Full Context)** | **COMPACT (YAML Signatures)** | 
| ----- | ----- | ----- | 
| **Total Files** | 121 | 121 | 
| **Characters** | 228,614 | 58,752 | 
| **Lines** | 7,328 | 1,565 | 
| **Tokens** | **61,192** | **16,765** | 

### 📉 Compression Efficiency

* **Ratio:** 3.6x smaller
* **Savings:** 72.6%

### ⚠️ Top 10 Most Expensive Files (Raw Tokens)

 1.  — 4,694 tk
 2.  — 2,739 tk
 3.  — 2,177 tk
 4.  — 2,163 tk
 5.  — 2,053 tk
 6.     — 1,733 tk
 7.     — 1,563 tk
 8.     — 1,535 tk
 9.  — 1,206 tk
10.  — 1,197 tk
Actual filenames are redacted since this is a private codebase. 

## 🗄️ SQL Migration Analysis

| **Metric** | **RAW (Full Context)** | **COMPACT (Schema Only)** | 
| ----- | ----- | ----- | 
| **Total Files** | 12 | 12 | 
| **Characters** | 9,604 | 3,602 | 
| **Lines** | 321 | 123 | 
| **Tokens** | **2,381** | **1,030** | 

### 📉 Compression Efficiency

* **Ratio:** 2.3x smaller
* **Savings:** 56.7%

## 🏆 Overall Summary

| **Metric** | **Value** | 
| ----- | ----- | 
| **Raw Total Tokens** | 63,573 | 
| **Compact Total Tokens** | 17,795 | 
| **Overall Compression** | **3.6x** | 
| **Token Savings** | **72.0%** | 

### 🧠 LLM Compatibility Check

* **Claude 3.5 Sonnet (200k):** ✅ (Fits Raw) | ✅ (Fits Compact)