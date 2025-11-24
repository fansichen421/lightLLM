.venv\Scripts\activate
# Start-Process cmd -ArgumentList "/c npx bing-cn-mcp"
Start-Process uvicorn -ArgumentList "backend:redirect_app --host 0.0.0.0 --port 80" -NoNewWindow
uvicorn backend:app --host 0.0.0.0 --port 443 --ssl-keyfile .key --ssl-certfile .crt --reload
