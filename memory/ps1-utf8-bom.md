---
name: ps1-utf8-bom
description: 本仓库所有 .ps1 必须存成 UTF-8 with BOM，否则含中文注释会在 Windows PowerShell 5.1 下解析失败
metadata:
  type: project
---

本仓库的 PowerShell 脚本（`scripts/**/*.ps1`）含中文注释，**必须保存为 UTF-8 with BOM**。

**Why:** Windows PowerShell 5.1 在脚本无 BOM 时按系统 ANSI（中文机为 GBK）解码，会把中文注释字节
错乱，进而触发 `ParseFile` 解析错误（典型现象：报 "Unexpected token '}'"，但花括号其实是平衡的）。
PS7 / .NET 的 `ParseInput` 用 UTF-8 则正常，所以容易误判为代码问题。

**How to apply:** 用 Write 工具写完 .ps1 后，再用 PowerShell 重写为带 BOM：
`[System.IO.File]::WriteAllText($f, [System.IO.File]::ReadAllText($f,[Text.Encoding]::UTF8), (New-Object Text.UTF8Encoding $true))`，
并用 `[Management.Automation.Language.Parser]::ParseFile` 校验。相关：[[session-history-system]]。
