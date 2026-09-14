fn main() {
    slint_build::compile("../../ui/launcher.slint").expect("failed to compile launcher.slint");
    slint_build::compile("../../ui/settings.slint").expect("failed to compile settings.slint");
    slint_build::compile("../../ui/screenshot.slint").expect("failed to compile screenshot.slint");
    slint_build::compile("../../ui/pin-window.slint").expect("failed to compile pin-window.slint");
    slint_build::compile("../../ui/translate-window.slint")
        .expect("failed to compile translate-window.slint");
}
