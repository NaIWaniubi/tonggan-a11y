# tessdata：OCR 语言包（chi_sim / eng，gzip 压缩的 .traineddata）

- 来源：<https://github.com/tesseract-ocr/tessdata_fast>（fast 整数化模型，与 tesseract 5 配套）
- 许可证：**Apache License 2.0**（该仓库自述；全文见 `../tesseract/LICENSE` 同一份）
- 用途：本项目把 `chi_sim.traineddata.gz` / `eng.traineddata.gz` 随产物**同源自托管**，
  `createWorker` 显式传 `langPath` + `gzip: true`——不依赖任何公网 CDN，
  这是「表格数据不离开本机」承诺的一部分。
- 分发方式：原样 gzip 字节，不重新编码、不解压。
