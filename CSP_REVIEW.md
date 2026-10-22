# Sửa CSP — READY FOR REVIEW

Ngày 22/10/2026. URL http://localhost:8080.

## Nguyên nhân

Script trong index.html và HTML qua HTTP có 189 cặp CRLF ở thời điểm chẩn đoán. Hash SHA-256 trên chuỗi thô là `sha256-dImAkXpEcw6l3Tm6Okh9VVzM1ieof/fwfZCkx+m7Soo=`. Trình duyệt chuẩn hóa CRLF/CR thành LF trong quá trình parse HTML; hash đúng của nội dung script sau chuẩn hóa là `sha256-2kJwfGbSzZmHS4+SUI18DKHZ06tR5p/sGmrIF4j63VM=`, trùng hash Chrome yêu cầu.

CSP cũ chỉ cho phép hash của chuỗi CRLF nên Chrome chặn toàn bộ script khởi tạo, khiến trang đứng ở “Đang khởi tạo...”. Test trước băm chuỗi response thô và tìm hash trong toàn bộ header nên đã PASS sai. Đây là lỗi trong cách kiểm tra trước đó.

Quy tắc tham khảo: [HTML input preprocessing](https://html.spec.whatwg.org/multipage/parsing.html#preprocessing-the-input-stream), [CSP inline source matching](https://www.w3.org/TR/CSP3/#match-element-to-source-list). Không trim nội dung script khi tính hash.

## File sửa

- `index.html`: chuẩn hóa toàn bộ xuống LF, giữ nguyên logic JavaScript/HTML.
- `.gitattributes` (mới): index.html và nginx/default.conf dùng LF để tránh Windows checkout chuyển lại CRLF.
- `nginx/default.conf`: script-src dùng hash Chrome yêu cầu; style-src dùng `sha256-8eJC1n4gE83izCxLHu+OmiTdhzkASCkjkihz3d4gQEg=`. Giữ CSP bật, không dùng unsafe-inline/unsafe-eval.
- `test/nginx.test.js`: băm script/style sau HTML newline normalization, kiểm tra trong đúng script-src/style-src; từ chối nội dung bị đổi và hash đặt sai directive. Regression test bao gồm LF, CRLF, CR; xác nhận hash CRLF thô không được chấp nhận.
- `README.md`, `REVIEW.md`, `UI_NGINX_REVIEW.md`: cập nhật hướng dẫn và dẫn tới báo cáo này; giữ báo cáo cũ như lịch sử.
- `evidence/csp-npm-test.txt`, `evidence/csp-test-docker.txt`, `evidence/csp-http.txt`: kết quả chạy và HTTP headers/hash thực tế.

Không sửa logic server.js, schema PostgreSQL hoặc mapping cổng trong lượt này.

## Triển khai và kiểm thử

Đã chạy docker compose config --quiet, nginx -t, rebuild app và khởi động lại Nginx bằng docker compose up -d --build app nginx. PostgreSQL giữ nguyên container/volume. Kiểm thử Docker tạo thêm dữ liệu/schema test và giữ lại; không reset hoặc xóa dữ liệu.

| Kiểm tra | Kết quả |
| --- | --- |
| Chẩn đoán hash script trong workspace và HTTP trước sửa | PASS — raw CRLF và normalized LF tái hiện đúng hai hash đã báo |
| Test mới chạy với CSP cũ chưa reload | FAIL như dự kiến — phát hiện mismatch mà test cũ bỏ sót |
| Hash script HTTP sau sửa, chuẩn hóa như browser | PASS — khớp đúng script-src |
| Hash style HTTP sau sửa | PASS — khớp đúng style-src |
| Header CSP bật, không unsafe-inline/unsafe-eval | PASS |
| HTTP 200 cho trang chủ và health PostgreSQL | PASS |
| nginx -t và docker compose config --quiet | PASS |
| npm test | PASS — 9 test, 0 FAIL |
| npm run test:docker | PASS — 3 kiểm tra: migration, restart/session/history, expiry |
| Backend realtime WebSocket/polling và đăng xuất | PASS — bộ test hiện có |
| Chrome thực thi script và hết kẹt trên giao diện | NOT TESTED bằng automation — inventory apps/browsers rỗng; cần kiểm tra trực tiếp sau hard reload |

## Lệnh kiểm tra lại

```powershell
docker compose config --quiet
docker compose exec -T nginx nginx -t
docker compose ps
curl.exe -I http://localhost:8080/
npm test
npm run test:docker
```

Test tích hợp tải HTML thật từ Nginx, lấy nội dung inline script/style, chuẩn hóa xuống LF, tính SHA-256 và đối chiếu token hash trong đúng directive. Nó không chỉ kiểm tra có một chuỗi hash trong header.

## Kiểm tra Chrome

1. Mở http://localhost:8080 rồi nhấn **Ctrl+Shift+R** để tải lại HTML và header mới.
2. Mở DevTools Console: xác nhận không còn lỗi “Executing inline script violates Content Security Policy”.
3. Trang phải chuyển từ “Đang khởi tạo...” sang form đăng nhập hoặc giao diện chat nếu session còn hiệu lực.
4. Network → response trang chủ → Content-Security-Policy phải chứa script hash `sha256-2kJwfGbSzZmHS4+SUI18DKHZ06tR5p/sGmrIF4j63VM=`.

Không còn test FAIL sau triển khai. UI Chrome thực tế vẫn cần xác nhận; không tự đánh dấu PASS. Nếu sửa inline script/style sau này, phải tính lại hash theo LF và rebuild app/reload Nginx. Restart app vẫn có thể gây gián đoạn ngắn trong phạm vi MVP.

Không commit/push/merge Git. Trạng thái: **READY FOR REVIEW**.
