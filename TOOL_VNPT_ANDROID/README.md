# VNPT TOOL Android - kiểm tra cập nhật bằng version.json  

## Cấu hình Google Drive

Ứng dụng đọc thông tin phiên bản từ file `version.json` có ID đã cấu hình trong `AppUpdater.java`:

`1i5zATdaEu-cVQsKRRe5n2EhjXTAtTjcK`

Nội dung file JSON phải đúng cấu trúc:

```json
{
  "versionCode": 4,
  "versionName": "1.2.0",
  "apkFileId": "ID_FILE_APK_TREN_GOOGLE_DRIVE",
  "description": "Cập nhật chức năng mới"
}
```

- `versionCode`: số nguyên tăng dần, phải lớn hơn versionCode đang cài để báo có bản mới.
- `versionName`: tên phiên bản hiển thị.
- `apkFileId`: ID của file APK mới trên Google Drive.
- `description`: mô tả cập nhật, có thể để chuỗi rỗng.

Cả `version.json` và APK cần bật chia sẻ **Bất kỳ ai có đường liên kết** (vai trò Người xem).

## Mỗi lần phát hành APK mới

1. Biên dịch APK với `versionCode` lớn hơn bản trước.
2. Tải APK lên Drive và lấy ID của file APK.
3. Cập nhật `version.json` với `versionCode`, `versionName`, `apkFileId` mới.
4. Giữ nguyên file JSON (không xóa tạo file khác) để ID JSON không đổi.

## Hành vi nút CẬP NHẬT

- Khi nhấn nút, ứng dụng chỉ tải `version.json` (không tải APK để kiểm tra).
- So sánh `versionCode` trong JSON với phiên bản đang cài.
- Nếu có bản mới, nút **Mở Drive tải APK** mở đúng file APK được khai báo trong `apkFileId`.
- Bản sửa này giữ cơ chế tải/cài APK hiện tại của dự án; không tự động cài APK.

## Lưu ý

Chưa biên dịch hoặc kiểm thử trên thiết bị Android trong môi trường này. Hãy build và thử với một APK có versionCode lớn hơn bản đang cài.


## Phân luồng Wi-Fi modem và 4G (bản cập nhật)

- `NetworkRouter` đăng ký theo dõi Wi-Fi mà không yêu cầu Wi-Fi phải có Internet, đồng thời yêu cầu một mạng di động có Internet.
- Các request trực tiếp đến IP modem (`modem=true`) được gắn với `Network` Wi-Fi.
- Các request HTTPS VNPT và OneLink được gắn với `Network` di động (4G).
- DNS cũng được phân giải trên đúng `Network`, tránh trường hợp socket đi 4G nhưng DNS lại theo mạng mặc định Wi-Fi.
- Bổ sung quyền `ACCESS_NETWORK_STATE` và `CHANGE_NETWORK_STATE`.

Lưu ý kiểm thử: cần build bằng Android SDK/Gradle và thử trên thiết bị thật. Khi thử, kết nối Wi-Fi modem không có Internet, bật dữ liệu di động, sau đó xác nhận API modem truy cập được qua Wi-Fi và API VNPT trả dữ liệu qua 4G. Không thể xác nhận hành vi của từng firmware Android chỉ bằng kiểm tra mã nguồn.
