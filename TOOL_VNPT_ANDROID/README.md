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
