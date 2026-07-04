# Configuration

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `WEB_HOST` | Web server bind address (`0.0.0.0` for Docker/production) | `localhost` |
| `WEB_PORT` | Web server port | `8082` |
| `BLUESKY_SERVER_HOST` | BlueSky server hostname/IP address | `localhost` |
| `FLASK_ENV` | Set to `production` for production deployment | — |
| `HEARTBEAT_INTERVAL` | Connection heartbeat interval in seconds | `30` |

!!! warning "Binding for containers"
    `WEB_HOST` defaults to `localhost` for security. Production and Docker
    deployments must set `WEB_HOST=0.0.0.0` so the server is reachable from
    outside the container.

Additional variables for the [integrated build](integrated-build.md):

| Variable | Description | Default |
|---|---|---|
| `WEBATM_INTEGRATED` | Set to `1` to enable the integrated backend hooks | unset |
| `WEBATM_AUTO_START` | Set to `0` to disable first-boot BlueSky auto-start | enabled |
| `WEBATM_AUTOSTART_MARKER` | Path of the first-boot marker file | `/dev/shm/webatm_autostart.done` |

## Network ports

| Port | Direction | Purpose |
|---|---|---|
| `8082` | browser → WebATM | Web interface (HTTP + Socket.IO) |
| `11000` | WebATM → BlueSky | Command port — sending simulation commands and events |
| `11001` | BlueSky → WebATM | Data port — receiving real-time simulation data |

!!! important
    The BlueSky ports (11000/11001) are **not configurable**. Ensure your
    BlueSky server runs with the default port configuration.

## Production deployment checklist

1. Configure environment variables in `docker-compose.yml`.
2. Set `FLASK_ENV=production` and `WEB_HOST=0.0.0.0`.
3. Deploy with `docker-compose up -d`.
4. Monitor with `docker-compose ps` and `docker-compose logs -f webatm`.

### Security features

- Capability dropping and no-new-privileges in Docker.
- Session management with configurable timeouts.
- Heartbeat-based connection monitoring.
- Environment-based configuration.
