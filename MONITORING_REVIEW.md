# Monitoring Đề 32 — READY FOR REVIEW

Ngày 22/10/2026. Workspace E:\DeTai32_chat. Giữ nguyên ứng dụng Chat, PostgreSQL và CSP; không triển khai Loki/Promtail, không commit/push/merge Git.

## Dịch vụ và cấu hình

Tận dụng hai service Prometheus/Grafana và các volume đã khai báo, không tạo service trùng. Profile `monitoring` đã bật trong .env cục bộ, không ghi đè DB_PASSWORD/SESSION_SECRET. Secrets mới nằm trong .secrets/, bị Git và Docker build context bỏ qua.

| Service | Image | Vai trò/truy cập |
| --- | --- | --- |
| prometheus | prom/prometheus:v3.5.0 | Scrape 5 giây, timeout 4 giây, retention 7 ngày; http://127.0.0.1:9090 |
| grafana | grafana/grafana:12.1.1 | Datasource/dashboard provisioning; http://127.0.0.1:3001 |
| cadvisor | ghcr.io/google/cadvisor:0.54.0 | CPU, RAM, network container; chỉ mạng monitoring nội bộ |
| postgres-exporter | quay.io/prometheuscommunity/postgres-exporter:v0.17.1 | Chỉ kết nối PostgreSQL bằng chat_metrics; không publish |
| nginx-exporter | nginx/nginx-prometheus-exporter:1.4.2 | Scrape nginx:8081/stub_status; không publish |
| postgres-metrics-init | postgres:16 | One-shot tạo/cấp quyền tài khoản exporter trên database hiện có; Exited 0 là thành công |

Node.js, PostgreSQL và Nginx hiện có tiếp tục chạy. PostgreSQL không bị recreate/reset để triển khai monitoring. Nginx giữ CSP/security headers, thêm listener nội bộ 8081 với ACL private IP; port này không publish. `/metrics` và `/stub_status` qua web 8080 trả 404. Metrics app chỉ scrape qua app:3000 trong Docker.

## Targets đã kiểm chứng

| Job | URL Docker | Trạng thái thực tế |
| --- | --- | --- |
| chat-app | http://app:3000/metrics | UP |
| postgres | http://postgres-exporter:9187/metrics | UP; pg_up=1 |
| nginx | http://nginx-exporter:9113/metrics | UP; nginx_up=1 |
| cadvisor | http://cadvisor:8080/metrics | UP; có series riêng cho app, postgres, nginx và các container monitoring |
| prometheus | http://localhost:9090/metrics | UP |

Chi tiết scrape URL, lastError, giá trị và nhãn ở evidence/monitoring.json. Không đánh giá chỉ theo target UP: từng biểu thức panel phải có kết quả số hữu hạn và Grafana phải trả frame số không rỗng.

## Dashboard và dữ liệu

Dashboard **De32 Chat Monitoring**, UID `de32-chat-monitoring`, folder De32:
http://127.0.0.1:3001/d/de32-chat-monitoring

| Panel | Metrics/PromQL chính | Kiểm chứng |
| --- | --- | --- |
| Targets UP | up | 5 series, giá trị 1 |
| Container CPU (%) | rate(container_cpu_usage_seconds_total[1m]) * 100, tổng theo name | Có dữ liệu thực |
| Container RAM | container_memory_working_set_bytes | Có dữ liệu thực |
| Container network receive | rate(container_network_receive_bytes_total[1m]) | Có dữ liệu thực |
| Container network transmit | rate(container_network_transmit_bytes_total[1m]) | Có dữ liệu thực |
| PostgreSQL UP | pg_up | 1 |
| PostgreSQL connections | pg_stat_database_numbackends{datname="chatdb"} | Có dữ liệu thực |
| Nginx active connections | nginx_connections_active | Có dữ liệu thực |
| Nginx requests/second | rate(nginx_http_requests_total[1m]) | Có dữ liệu thực |
| HTTP requests/second | sum by(route)(rate(chat_http_requests_total[1m])) | Có dữ liệu thực |
| HTTP duration p95 | histogram_quantile trên rate(chat_http_request_duration_seconds_bucket[1m]) | Có giá trị hữu hạn |
| Socket.IO connections | chat_socketio_connections | Có dữ liệu thực, >=1 khi giữ socket kiểm thử |

Biểu thức đầy đủ kèm filters nằm trong grafana/dashboards/chat.json và evidence/monitoring.json. 12/12 panel được truy vấn trực tiếp trên Prometheus, sau đó truy vấn qua **Grafana /api/ds/query** và kiểm tra numeric frame có mẫu thật. Datasource health trả OK. Không dùng số liệu giả/mock để lấp panel trống.

App tiếp tục dùng thư viện hiện có @prometheus-io/client. Khi kiểm tra npm, prom-client@15.1.3 báo deprecated và chỉ sang @prometheus-io/client; không giữ thêm dependency cũ. HTTP metrics dùng template route/method/status_code; đường dẫn tùy ý là unmatched, không có account/room/message/query string. Gauge Socket.IO không có labels theo người dùng. Các metric Express không bao gồm HTTP do engine Socket.IO xử lý; gauge theo dõi socket đã xác thực.

## Quyền và secrets

- chat_metrics không superuser/createdb/createrole/replication; có pg_monitor và quyền CONNECT chatdb. Kiểm tra SQL xác nhận không có SELECT bảng users. pg_monitor là role thống kê tích hợp PostgreSQL, không cấp quyền SELECT dữ liệu chat.
- Tham khảo quyền exporter: [postgres_exporter chính thức](https://github.com/prometheus-community/postgres_exporter); cấu hình cAdvisor: [cAdvisor chính thức](https://github.com/google/cadvisor); Nginx exporter: [NGINX Prometheus exporter](https://github.com/nginx/nginx-prometheus-exporter).
- Mật khẩu exporter và Grafana được tạo ngẫu nhiên bằng scripts/setup-monitoring.js, không in ra console, không ghi vào source/JSON báo cáo. Compose mounts secret vào container. Không ghi đè secret có sẵn.
- Grafana admin là `admin`; người dùng đọc mật khẩu trong file cục bộ .secrets/grafana_admin_password bằng editor. Không chụp file này trong ảnh minh chứng.
- Prometheus/Grafana chỉ bind 127.0.0.1. App/PostgreSQL/exporter/cAdvisor không có host ports.
- cAdvisor có privileged và host read-only mounts/socket theo yêu cầu đọc số liệu kernel/runtime; đây không phải sandbox chống người quản trị Docker. Mount socket read-only không biến Docker API thành API chỉ đọc. Chỉ dùng trong môi trường quản trị tin cậy; không public exporter.

## Kết quả kiểm thử

| Kiểm tra | Kết quả | Minh chứng |
| --- | --- | --- |
| docker compose config --quiet | PASS | Không lỗi cấu hình |
| docker compose up -d --build | PASS sau sửa cAdvisor | Dịch vụ hiện chạy, one-shot Exited 0 |
| docker compose ps -a | PASS | evidence/monitoring-runtime.txt |
| promtool check config, nginx -t | PASS | evidence/monitoring-runtime.txt |
| Tất cả 5 target | PASS | 5 UP, lastError rỗng |
| pg_up/nginx_up | PASS | Giá trị 1 |
| CPU/RAM/network thật từng container Chat/PostgreSQL/Nginx | PASS | Kiểm tra labels và series không rỗng |
| Grafana datasource và dashboard provisioning | PASS | Health OK; API tìm được UID và đủ 12 panel |
| Dữ liệu cả 12 panel | PASS qua API | Numeric frames thực tế, không rỗng/NaN |
| Labels HTTP không chứa đường dẫn tùy ý hoặc dữ liệu chat | PASS | Probe URL chứa tên test; kiểm tra fixed allowed routes và label keys |
| Cổng quản trị chỉ loopback, exporter/database không publish | PASS | Kiểm tra Compose config trong script |
| Public /metrics và /stub_status | PASS | HTTP 404 |
| Quyền tài khoản exporter | PASS | SQL f/f/f/f/pg_monitor=true/SELECT users=false |
| npm test | PASS | 9 test, 0 FAIL; evidence/monitoring-regression.txt |
| npm run test:docker | PASS | 3 kiểm tra; evidence/monitoring-docker.txt |
| Chat HTTP, CSP, WebSocket/polling, session và lịch sử sau restart | PASS | Bộ regression và HTTP cuối |
| Hình thức dashboard trên browser/ảnh chụp | NOT TESTED bằng automation | CUA inventory apps/browsers rỗng; cần chụp thủ công |

UI Chat đã được người dùng xác nhận chạy thành công trước lượt này. Không suy diễn kết quả đó thành kiểm thử trực quan dashboard Grafana.

## Lỗi đã gặp và giới hạn

1. cAdvisor crash trên Docker Desktop dùng overlayfs/containerd snapshotter khi thiếu containerd socket. Đã mount host /run/containerd vào /containerd và đặt --containerd=/containerd/containerd.sock. Mount riêng tránh xung đột với mount read-only /var/run; sau đó thu hẹp /var/run thành docker.sock. Container healthy và có CPU/RAM/network thật.
2. Lần kiểm tra đầu query rate/p95 rỗng hoặc frame chưa có điểm sau traffic mới. Không đánh dấu PASS; verifier hiện phát traffic thật, chờ nhiều scrape và nhiều bước thời gian Grafana, sau đó yêu cầu mọi panel có numeric frame. Lần cuối PASS.
3. cAdvisor phản ánh container/Linux VM Docker Desktop, không phải toàn bộ hệ điều hành Windows. Host Linux/runtime khác có thể cần điều chỉnh socket/mount.
4. CPU % là phần trăm của một CPU core nên có thể >100 khi dùng nhiều core. Network có thể gồm nhiều interface. Dashboard hiện hiển thị các Docker container cAdvisor quan sát được, không chỉ một process Node.
5. Rate/p95 có thể trống khi không có request mới; cần traffic và thời gian scrape. Socket connections=0 khi không có người dùng là dữ liệu hợp lệ. Counter/gauge process reset khi restart app; rate xử lý counter reset.
6. Grafana admin secret chỉ áp dụng khi khởi tạo database; giữ secret/volume đồng bộ. Không tự reset password hoặc volume khi đăng nhập thất bại.
7. Chưa triển khai HTTPS, alert rules, Loki/Promtail hay load test trong bước này. Prometheus không có auth nhưng chỉ mở loopback. Không kết luận đã harden production toàn bộ.

## File thay đổi

- compose.yaml: tận dụng Prometheus/Grafana, khóa phiên bản, loopback ports, provisioning, exporter/cAdvisor, secret và one-shot SQL.
- prometheus/prometheus.yml: 5 scrape jobs, timeout.
- server.js: HTTP counter/histogram và Socket.IO gauge; giữ nghiệp vụ Chat.
- nginx/default.conf: metrics private và stub_status listener nội bộ; giữ nguyên CSP hash/security headers.
- grafana/provisioning/datasources/prometheus.yml, grafana/provisioning/dashboards/chat.yml, grafana/dashboards/chat.json: provisioning và 12 panel.
- monitoring/postgres-init.sql, monitoring/postgres-exporter.yml: quyền tối thiểu và cấu hình exporter.
- scripts/setup-monitoring.js, scripts/verify-monitoring.js, package.json: setup secret và kiểm chứng thực tế.
- .env.example, .gitignore, .dockerignore: profile mẫu, bỏ qua secret/evidence trong image. .env cục bộ chỉ bổ sung profile, không đưa vào Git.
- README.md, MONITORING_REVIEW.md, evidence/monitoring*: hướng dẫn và kết quả.

Dockerfile đã được đọc, tiếp tục npm ci --omit=dev và USER node, không cần sửa. index.html/CSP hash không đổi. Không xóa volume hoặc dữ liệu; tài khoản/phòng/tin nhắn/schema kiểm thử được giữ lại.

## Lệnh chạy/kiểm tra

```powershell
node scripts/setup-monitoring.js
docker compose --profile monitoring config --quiet
docker compose --profile monitoring up -d --build
docker compose ps -a
docker compose exec -T prometheus promtool check config /etc/prometheus/prometheus.yml
docker compose exec -T nginx nginx -t
npm run test:monitoring
npm test
npm run test:docker
curl.exe http://localhost:8080/health
curl.exe http://127.0.0.1:9090/api/v1/targets
```

Local .env hiện bật monitoring nên không bắt buộc --profile. Verifier đọc mật khẩu trong secret local, không in auth header/password; tạo tài khoản test với hậu tố ngẫu nhiên, giữ socket và gửi health traffic để đo dữ liệu thật. Không xóa dữ liệu test.

## Danh sách ảnh cần chụp

Các ảnh dưới đây chưa được automation chụp; người dùng cần chụp để đưa vào báo cáo:

1. `01-compose-ps.png`: terminal docker compose ps -a, thấy loopback ports và database/cAdvisor healthy.
2. `02-prometheus-targets.png`: http://127.0.0.1:9090/targets, đủ 5 target UP.
3. `03-grafana-datasource.png`: datasource Prometheus, Save & test/health thành công; không chụp secret.
4. `04-dashboard-containers.png`: CPU/RAM/network có đường dữ liệu và tên container.
5. `05-dashboard-postgres-nginx.png`: pg_up=1, kết nối PostgreSQL, Nginx active/requests.
6. `06-dashboard-http-socketio.png`: phát sinh request và mở hai phiên Chat, chụp HTTP rate/p95/Socket.IO connections có dữ liệu.
7. `07-regression-tests.png`: npm test và npm run test:docker PASS.
8. `08-chat-still-working.png`: Chat qua localhost:8080 vẫn sử dụng được sau triển khai.

Trạng thái: **READY FOR REVIEW**.
