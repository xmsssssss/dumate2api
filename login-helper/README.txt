DuMate local login helper

1. Run start-login-helper.cmd.
2. Enter the admin URL shown in the web page.
3. Enter the one-time pairing code shown in the web page.
4. Complete the Baidu login in the Chrome or Edge window that opens.

The helper uses a temporary browser profile, reads only the Baidu login
cookie required by the admin server, submits it with the one-time pairing
code, and deletes the temporary profile when it exits.

Requirements and limits:

- Windows 10/11 with Google Chrome or Microsoft Edge installed.
- The pairing code expires after 15 minutes and can be used only once.
- The temporary browser profile is normally deleted when the helper exits.
- The admin URL may be a LAN address or public Docker deployment address.
- The helper does not use the admin cookie and does not need a browser plugin.

If Windows blocks the script, run start-login-helper.cmd as your normal user.
Send the admin URL and pairing code only to the helper you just downloaded.
