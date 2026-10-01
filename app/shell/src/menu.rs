//! The application menu bar, and the keyboard shortcuts that come with it.
//!
//! A remote-URL shell inherits none of a browser's window management: there is
//! no address bar, no tab strip, and — crucially — no Cmd-R and no Cmd-N. Those
//! are muscle memory, and their absence reads as the app being broken rather
//! than as the app being small. The menu is where they come back.
//!
//! The whole bar is spelled out rather than extended from `Menu::default`,
//! because the default's File and View submenus are built inline and cannot be
//! reached afterwards to insert into. Everything here that is NOT one of our own
//! items mirrors that default exactly, Edit included: without the predefined
//! Cut/Copy/Paste items macOS routes no clipboard shortcut to the web view at
//! all, which is the failure mode of hand-rolling a menu bar.
//!
//! `Server…` is ours for a different reason: it opens the bootstrap page, which
//! is no longer somewhere a window passes through on the way in, so without a
//! menu item there would be no way to reach it that is not a failure.

use std::time::Duration;

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

use crate::buildinfo;

const NEW_WINDOW: &str = "new-window";
const SERVER: &str = "server";
const RELOAD: &str = "reload";
const FORCE_RELOAD: &str = "force-reload";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let package = app.package_info();
    let config = app.config();
    // The two version lines macOS actually shows: `version` is the "Version …"
    // line and `short_version` is the build in parentheses after it, which is
    // where the commit belongs. So a real release reads "Version 0.14.1
    // (88b944c8)" and a local build off main reads "Version 0.14.1-dev
    // (88b944c8-dirty)" — the panel names the build, not just the tree it came
    // from, because that is the question someone opens it to answer.
    let build = buildinfo::current(app);
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(build.version_label()),
        short_version: build.commit_label(),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, NEW_WINDOW, "New Window", true, Some("CmdOrCtrl+N"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
            // On macOS this sits in the application submenu, where a setting for
            // the whole app belongs; nothing else has one.
            #[cfg(not(target_os = "macos"))]
            &MenuItem::with_id(app, SERVER, "Server…", true, None::<&str>)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // "Reload" is the page coming back; "Force Reload" additionally throws away
    // everything WebKit is holding for the origin. Same two shortcuts a browser
    // uses, so the second is discoverable from the first without being labelled.
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(
                app,
                FORCE_RELOAD,
                "Force Reload",
                true,
                Some("CmdOrCtrl+Shift+R"),
            )?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                package.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about.clone()))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, SERVER, "Server…", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &file,
            &edit,
            &view,
            &window,
            &Submenu::with_items(
                app,
                "Help",
                true,
                &[
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                ],
            )?,
        ],
    )
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        NEW_WINDOW => {
            crate::open_app_window(app, None);
        }
        // The only way to the bootstrap page that is not a failure. Since a
        // window now loads the server directly, a server that cannot be reached
        // no longer forces that page in front of the user — so pointing the shell
        // somewhere else has to be something they can ask for.
        SERVER => {
            crate::open_bootstrap_window(app);
        }
        RELOAD => {
            if let Some(window) = crate::menu_target(app) {
                let _ = window.reload();
            }
        }
        // Clearing comes FIRST and the reload follows it, so the fresh load is
        // the one that repopulates the caches. The app's auth token is injected
        // into the served HTML rather than stored in the page, so wiping the
        // origin's storage costs local preferences and caches — never the
        // session.
        //
        // The two are separated in TIME because WebKit removes website data
        // asynchronously and wry hands us no completion hook: a reload issued in
        // the same breath can be served out of the very cache it was meant to
        // drop, and any storage the page rewrites on load would survive. Held off
        // the main thread so the wait is not the UI's.
        FORCE_RELOAD => {
            if let Some(window) = crate::menu_target(app) {
                let _ = window.clear_all_browsing_data();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(250));
                    let _ = window.reload();
                });
            }
        }
        _ => {}
    }
}
