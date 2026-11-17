FROM python:3.12-alpine
WORKDIR /app
COPY --chown=10001:10001 server.py .
COPY --chown=10001:10001 web ./web
RUN adduser -D -u 10001 wearlog && mkdir /data && chown wearlog /data
USER wearlog
ENV WEARLOG_DB=/data/wearlog.sqlite3 PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/health')"
CMD ["python", "server.py"]
