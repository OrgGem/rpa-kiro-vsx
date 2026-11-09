# Kiro CLI ACP for VS Code

Extension VS Code dùng Kiro CLI để trò chuyện và làm việc với thư mục đang mở qua Agent Client Protocol (ACP).

## Yêu cầu và phạm vi

- Khởi tạo project Node.js/TypeScript trong repo `OrgGem/rpa-kiro-vsx`, chạy trên VS Code Desktop và đóng gói cài được dưới dạng VSIX.
- Dùng [kiro-vscode-extension của AsadBinImtiaz](https://github.com/AsadBinImtiaz/kiro-vscode-extension/tree/cb4da49b04371f7fed96976a24d20e5cff9a6d4d) làm **project mẫu** cho cách tách extension host, chat webview và quản lý tiến trình CLI.
- Tham khảo [kiến trúc ACP của KiroCrew](https://github.com/kirodotdev/KiroCrew/blob/a2a0da41ff3b7c20bd33f6375c28170a6bc5f68a/docs/system-specs/modules/acp-client.md) cho cách tách vòng đời phiên khỏi giao diện và để Kiro quản lý phiên, thực thi tool và lưu lịch sử.
- Kết nối trực tiếp qua `kiro-cli acp`, dùng JSON-RPC 2.0 UTF-8, mỗi thông điệp một dòng qua stdin/stdout. Hỗ trợ chọn harness V2 hoặc V3, mặc định dùng V3, và đọc capability từ kết quả `initialize`. Xem [đặc tả ACP v1](https://agentclientprotocol.com/protocol/v1/transports) và [khác biệt giữa Kiro CLI V2 và V3](https://kiro.dev/docs/cli/v3/acp-migration/).
- Mở phiên theo thư mục dự án, gửi prompt văn bản, hiển thị phản hồi và trạng thái tool theo luồng, dừng lượt đang chạy và bắt đầu phiên mới. Nếu CLI hỗ trợ, mở lại phiên và chọn model/mode/effort từ lựa chọn CLI cung cấp.
- Hiển thị lựa chọn cấp hoặc từ chối quyền một lần khi agent yêu cầu. Chỉ chạy CLI trong workspace đã được VS Code đánh dấu tin cậy.
- Hiển thị spec và tiến độ từ `.kiro/specs/`. Chuẩn bị prompt cho từng task hoặc theo chế độ chạy trong chat ACP.

## Môi trường

- VS Code Desktop 1.105 trở lên.
- [Kiro CLI](https://kiro.dev/docs/cli/) cài trên máy chạy extension host, có trong PATH hoặc được cấu hình đường dẫn, và đã đăng nhập bằng `kiro-cli login`.
- Node.js 22 trở lên và npm khi phát triển hoặc đóng gói project.

## Cài và sử dụng

1. Trong terminal trên máy chạy extension host, chạy `kiro-cli --version` và `kiro-cli login`. Nếu vừa cập nhật PATH, hãy mở lại VS Code.
2. Chạy các lệnh dưới đây tại thư mục project. Có thể dùng **Extensions → Install from VSIX…** thay cho lệnh `code --install-extension`.

   ```sh
   npm ci
   npm run package
   code --install-extension dist/rpa-kiro-vsx.vsix
   ```

3. Mở một thư mục tin cậy trong VS Code và chọn **Kiro CLI: Open Chat** từ Command Palette. Nếu có nhiều thư mục, chọn thư mục muốn dùng làm working directory.
4. Nhập câu hỏi và nhấn **Send** hoặc `Ctrl+Enter` (`Cmd+Enter` trên macOS). **Stop** hủy lượt hiện tại. **New chat** tạo phiên mới. **Open session** liệt kê phiên hoặc cho nhập ID tùy theo capability của CLI. **Configure** xuất hiện khi phiên có tùy chọn.
5. Khi Kiro yêu cầu quyền chạy tool, xem hành động và chọn một trong các quyền một lần mà CLI cung cấp. Nhấn **Output** để xem stderr của CLI và lỗi kết nối.

### Cấu hình

Trong User Settings của VS Code, tìm **Kiro CLI ACP: Engine** và chọn **v2** hoặc **v3**. Đóng rồi mở lại tab chat để áp dụng. Trên Windows có thể chỉ định đường dẫn đầy đủ đến `kiro-cli.exe`.

```json
{
  "rpaKiro.cliPath": "kiro-cli",
  "rpaKiro.engine": "v2"
}
```

- **V2** dùng `kiro-cli acp --agent-engine=v2` nếu CLI công bố cờ này. Với CLI 2.x có ACP nhưng chưa có cờ, extension chạy `kiro-cli acp`. **Configure** dùng danh sách model do phiên cung cấp và gọi `session/set_model`. Nếu CLI hỗ trợ mở lại phiên mà thiếu `session/list`, **Open session** cho nhập ID.
- **V3** dùng `kiro-cli acp --agent-engine=v3`. **Configure** dùng các tùy chọn mà phiên cung cấp qua ACP.
- `rpaKiro.acpArgs` nhận đối số bổ sung. Khi bạn đặt `rpaKiro.engine` rõ ràng, giá trị này ghi đè cờ `--agent-engine` trong mảng. Nếu chỉ đặt `rpaKiro.acpArgs`, extension tiếp tục dùng mảng đó làm toàn bộ đối số sau `acp` để tương thích với cấu hình cũ.

Extension dùng đăng nhập do CLI quản lý, gửi prompt văn bản, hiển thị kết quả dạng văn bản và chỉ cho cấp hoặc từ chối quyền một lần. Kiro quản lý tool và lưu phiên. Workflow Spec gốc của Kiro, tệp đính kèm, slash command riêng của Kiro và lưu quyền lâu dài nằm ngoài phạm vi bản này.

### Spec Explorer và chạy task

1. Mở **Kiro Specs** trên Activity Bar. **Spec Explorer** nhóm spec theo workspace folder và hiển thị cả spec nháp đã có tài liệu nhưng chưa có `tasks.md`.
2. Mở spec để xem `requirements.md` hoặc `bugfix.md`, `design.md` và `tasks.md` nếu có. Chọn task để mở đúng dòng trong checklist.
3. Dùng nút **Run Task with Kiro** cạnh task chưa hoàn thành. Hoặc dùng nút **Prepare Spec Prompt…** cạnh tên spec để chọn **Run next task**, **Run remaining tasks** hoặc **Review spec**. Hai chế độ chạy theo danh sách chỉ chọn task bắt buộc chưa hoàn thành. Có thể chọn riêng một task tùy chọn.
4. Prompt xuất hiện trong chat của workspace folder tương ứng. Nếu ô nhập đã có nội dung, chọn **Replace draft** khi muốn thay thế. Xem lại hoặc sửa prompt rồi nhấn **Send** để gửi qua ACP V2 hoặc V3.

Tiến độ phản ánh các checkbox trong `tasks.md` đã lưu. Sidebar tự làm mới khi file thay đổi. Extension không sửa checklist khi chuẩn bị prompt hoặc tự đánh dấu hoàn thành khi lượt chat kết thúc.

### Steering và kiểm tra chất lượng

**Kiro Steering** trên Activity Bar liệt kê các file Markdown trong `.kiro/steering/` và file `.kiro/rpa-quality.json` của từng workspace folder.

1. Chọn **Kiro Steering: Preview Local Pack…** và chỉ định thư mục pack. Đặt file Markdown ở cấp đầu của pack hoặc cấp đầu của thư mục con `steering/`. Pack có thể kèm `quality.json` ở cấp đầu. Mỗi file nhập phải là UTF-8 và tối đa 256 KiB.
2. Mở từng thay đổi trong **Pending pack** để xem diff gốc của VS Code. File thêm mới có vế trước trống. Extension giữ bản nội dung đã xem để áp dụng đúng diff.
3. Chọn **Apply Reviewed Pack** và xác nhận. Extension thêm hoặc thay từng file trong diff. Nếu file đích đã thay đổi hoặc còn chỉnh sửa chưa lưu, hãy lưu rồi preview lại. **Discard Pack Preview** bỏ bản xem trước.

Extension lưu tài liệu vào `.kiro/steering/` và nhập `quality.json` vào `.kiro/rpa-quality.json`. Bộ kiểm tra chạy local khi mở hoặc lưu file và hiển thị kết quả dưới nguồn **Kiro Quality** trong **Problems**. Dùng **Kiro Quality: Validate Current File** để chạy thủ công. File steering được kiểm tra cú pháp YAML và cấu hình `inclusion`, `fileMatchPattern` hoặc `description` tương ứng.

Rule khai báo dùng dạng `hooks` của [KiroForge](https://github.com/hsiddhu2/kiroforge-extension/blob/main/extension/src/models/Hook.ts). Bản này hỗ trợ `onFileSave`, regex tìm nội dung vi phạm, regex yêu cầu tên file và giới hạn kích thước theo KiB. Regex dùng RE2 và kiểm tra nội dung file tới 512 KiB. `fileTypes` nhận phần mở rộng như `ts`, `*.ts`, `d.ts` hoặc `*`. Ví dụ `quality.json`:

```json
{
  "hooks": [
    {
      "id": "no-debug",
      "trigger": "onFileSave",
      "fileTypes": ["*.ts", "*.js"],
      "severity": "warning",
      "validation": {
        "type": "regex",
        "pattern": "console\\.debug\\(",
        "message": "Remove debug output before committing."
      }
    }
  ]
}
```

### Proxy cho request do extension gửi

Đặt **Kiro CLI ACP: Direct Proxy Url** trong User Settings trên máy chạy extension host. Hỗ trợ proxy HTTP hoặc HTTPS có CONNECT.

```json
{
  "rpaKiro.directProxyUrl": "http://proxy.example.com:8080"
}
```

Nếu proxy yêu cầu Basic authentication, URL có dạng `http://username:password@proxy.example.com:8080`. Mã hóa các ký tự đặc biệt trong thông tin đăng nhập, chẳng hạn `@` thành `%40`. VS Code lưu URL này trong User Settings của máy.

Chạy **Kiro CLI: Check Direct Kiro Connection** từ Command Palette. Lệnh gửi một request HTTPS đến [manifest phát hành công khai của Kiro](https://prod.download.cli.kiro.dev/stable/latest/manifest.json) và báo trạng thái HTTP. Hiện đây là luồng gửi request trực tiếp của extension. Để trống setting để dùng cấu hình mạng của VS Code. Nếu đã đặt proxy riêng mà proxy lỗi, lệnh trả lỗi thay vì thử kết nối trực tiếp.

Chat, đăng nhập và các lượt gọi mô hình qua ACP vẫn dùng tiến trình `kiro-cli`. [Cấu hình proxy dành cho Kiro CLI](https://kiro.dev/docs/cli/quick-start/#proxy-configuration) được quản lý riêng.

## Phát triển

- `npm ci` cài dependency theo lockfile.
- Nhấn **F5** để biên dịch và mở Extension Development Host.
- `npm test` kiểm thử ACP V2/V3 với tiến trình mô phỏng, proxy CONNECT, đọc checklist và tạo prompt spec.
- `npm run package` tạo VSIX ở `dist/rpa-kiro-vsx.vsix`.

`src/extension.ts` đăng ký lệnh VS Code, `src/chat.ts` quản lý UI và vòng đời panel, còn `src/cli.ts` quản lý tiến trình và trao đổi ACP qua TypeScript SDK. Nội dung từ agent được hiển thị dưới dạng văn bản trong webview.
