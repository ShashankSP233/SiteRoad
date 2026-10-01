@echo off
echo Starting SiteRoad Backend...
pushd "%~dp0"
call pm2 restart "siteroad" --update-env
if errorlevel 1 call pm2 start server.js --name "siteroad"
popd
exit
