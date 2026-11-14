//
//  main.swift
//  进程入口。最小化：建 NSApplication、装 delegate、跑 run。
//  不走 nib —— 整个 UI 都用代码搭。
//

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
