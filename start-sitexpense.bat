@echo off
echo Starting SiteXpense Backend...
cd D:\sitexpense
call pm2 restart "sitexpense" --update-env
if errorlevel 1 call pm2 start server.js --name "sitexpense"
exit