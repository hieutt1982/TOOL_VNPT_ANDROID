# TOOL VNPT Android

Ứng dụng Android dùng **WebView + Java Bridge + OkHttp**, không khởi chạy Node.js, không mở HTTP server cục bộ, không cần Termux/Python.

## Các module
- **NS_V1, NS_V2, G040H:** giữ nguyên logic nghiệp vụ JavaScript được cung cấp; logic chạy trong WebView. `web-runtime.js` thay các API Node cần thiết cho luồng hiện tại (HTTP route nội bộ, Buffer, process, https request). Mọi kết nối HTTPS ra modem được chuyển qua `AndroidBridge` sang Java/OkHttp.
- **OneLink:** giữ giao diện HTML gốc; các route `/api/*` được chuyển trực tiếp sang Java/OkHttp trong `WebBridge`.

## HTTPS modem
- Chỉ bỏ xác minh chứng chỉ tự ký khi đích là IPv4 private/local (10/8, 172.16/12, 192.168/16, 169.254/16, loopback).
- Các host VNPT/OneLink dùng client HTTPS bình thường, vẫn xác minh chứng chỉ.
- Việc bỏ xác minh TLS trên mạng nội bộ vẫn có rủi ro giả mạo thiết bị; chỉ dùng với modem tin cậy trong mạng quản trị.

## Build APK bằng GitHub Actions
1. Upload toàn bộ thư mục dự án này lên repository GitHub.
2. Mở tab **Actions**.
3. Chọn workflow **Build TOOL VNPT APK** → **Run workflow**.
4. Tải artifact `TOOL-VNPT-debug-apk` sau khi workflow hoàn tất.

## Kiểm tra đã thực hiện trong môi trường tạo mã
- Đã kiểm tra cú pháp JavaScript của 3 backend và runtime.
- Đã chạy thử route trang chủ và `/api/status` của NS_V1, NS_V2, G040H trong môi trường giả lập WebView: đều trả HTTP 200.
- Đã kiểm tra ZIP đầu vào và giữ nguyên logic nguồn của 3 backend.
- Chưa thể kiểm thử đăng nhập/cấu hình trên modem thật trong môi trường này; cần kiểm tra trên thiết bị và mạng modem thực tế trước khi sử dụng tại khách hàng.
- Chưa biên dịch APK tại máy tạo mã vì môi trường không có Gradle/Android SDK; GitHub Actions được cấu hình để build.
