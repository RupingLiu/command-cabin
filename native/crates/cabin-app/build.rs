fn main() {
    slint_build::compile("../../ui/launcher.slint").expect("failed to compile launcher.slint");
    slint_build::compile("../../ui/settings.slint").expect("failed to compile settings.slint");
    slint_build::compile("../../ui/screenshot.slint").expect("failed to compile screenshot.slint");
    slint_build::compile("../../ui/pin-window.slint").expect("failed to compile pin-window.slint");
    slint_build::compile("../../ui/translate-window.slint")
        .expect("failed to compile translate-window.slint");

    // v1.0.1：exe 资源段嵌入多尺寸图标（16-96px，native/assets/icon.ico）与
    // 版本信息——桌面/开始菜单快捷方式与资源管理器读的是 exe 资源，此前缺失
    // 导致快捷方式图标空白（运行时窗口图标走 Slint 的 PNG 不受影响）。
    // 仅 Windows 目标嵌入（CARGO_CFG_WINDOWS 由 cargo 按目标注入）。
    if std::env::var("CARGO_CFG_WINDOWS").is_ok() {
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon("../../assets/icon.ico");
        resource.set("FileDescription", "CommandCabin launcher");
        resource.set("ProductName", "CommandCabin");
        resource.set("LegalCopyright", "Copyright 2026 CommandCabin");
        resource
            .compile()
            .expect("failed to embed windows icon resources");
    }
}
