@echo off
rem One-shot (Windows Task Scheduler): the tender-5 supplier reclaims its bond from the V1 escrow after its settle deadline.
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" scripts\withdraw.js 5 --key tender5-supplier --escrow 0x11f5f49ed28d34c8db973aa1f8c6579ba1b61e6b >> data\withdraw-tender5.log 2>&1
