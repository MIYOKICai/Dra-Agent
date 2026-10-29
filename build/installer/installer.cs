// Dra-Agent 自绘引导安装器（C# 5 / WinForms，.NET Framework 4.x 自带运行时）
// 亮色设计：左侧步骤栏（安装/完成/启动）+ 右侧内容区，四个页面：
//   欢迎（logo/简介/立即安装/协议勾选/版本号） → 进度（头部信息/进度条/三步清单/安装位置）
//   完成（对勾轨道图/立即启动/桌面快捷方式勾选） → 启动（全宽 splash，动画后拉起应用）
// 应用本体 zip 附加在 exe 尾部（footer：12 字节 magic + int64 长度）。
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    public const string AppName = "Dra-Agent";
    public const string AppVersion = "0.1.0";
    public static readonly string DefaultInstallDir = Directory.Exists(@"D:\")
        ? @"D:\Dra-Agent" // 默认在 D 盘新建 Dra-Agent 文件夹
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Dra-Agent");
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Dra-Agent";
    // footer：magic(12) + zip 长度(8)
    public static readonly byte[] ZipMagic = { 0x44, 0x52, 0x41, 0x5A, 0x49, 0x50, 0x56, 0x31, 0x30, 0x30, 0x30, 0x30 }; // "DRAZIPV10000"

    static Image logo;

    /** 嵌入资源 logo（黑圆角方块 + 白四角星），全局缓存 */
    public static Image LoadLogo()
    {
        if (logo == null)
        {
            using (var s = typeof(Program).Assembly.GetManifestResourceStream("DraLogo"))
                logo = Image.FromStream(s);
        }
        return logo;
    }

    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        bool isUninstallName = Path.GetFileName(Application.ExecutablePath)
            .StartsWith("Uninstall", StringComparison.OrdinalIgnoreCase);
        bool flagUninstall = args.Any(a => a.Equals("--uninstall", StringComparison.OrdinalIgnoreCase));
        string runParam = args.FirstOrDefault(a => a.StartsWith("--uninstall-run=", StringComparison.OrdinalIgnoreCase));
        if (runParam != null)
        {
            return Uninstall.DoDelete(runParam.Substring("--uninstall-run=".Length));
        }
        if (flagUninstall || isUninstallName) return Uninstall.Run();
        return InstallerForm.Run();
    }

    /** 把附加在 exe 尾部的 zip 复制到临时文件并返回其路径 */
    public static string ExtractEmbeddedZipToTemp()
    {
        using (var fs = new FileStream(Application.ExecutablePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            fs.Seek(-ZipMagic.Length - 8, SeekOrigin.End);
            var head = new byte[ZipMagic.Length + 8];
            if (fs.Read(head, 0, head.Length) != head.Length) throw new IOException("读取安装包尾部失败");
            for (int i = 0; i < ZipMagic.Length; i++)
            {
                if (head[i] != ZipMagic[i]) throw new IOException("安装包载荷缺失（footer 校验失败）");
            }
            long zipLen = BitConverter.ToInt64(head, ZipMagic.Length);
            fs.Seek(-ZipMagic.Length - 8 - zipLen, SeekOrigin.End);
            string temp = Path.Combine(Path.GetTempPath(), "dra-agent-install-" + Guid.NewGuid().ToString("N") + ".zip");
            using (var outFs = new FileStream(temp, FileMode.Create, FileAccess.Write))
            {
                var buffer = new byte[1 << 20];
                long remaining = zipLen;
                while (remaining > 0)
                {
                    int read = fs.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                    if (read <= 0) throw new IOException("读取安装包载荷中断");
                    outFs.Write(buffer, 0, read);
                    remaining -= read;
                }
            }
            return temp;
        }
    }
}

/* ============================= 安装 UI ============================= */

class InstallerForm : Form
{
    // 亮色设计令牌
    static readonly Color CPage = Color.White;          // 内容区
    static readonly Color CSidebar = Color.FromArgb(0xFF, 0xFA, 0xFA, 0xFB); // 侧栏
    static readonly Color CInk = Color.FromArgb(0xFF, 0x18, 0x18, 0x1B);     // 主文字/黑按钮
    static readonly Color CMuted = Color.FromArgb(0xFF, 0x71, 0x71, 0x7A);   // 次要文字
    static readonly Color CFaint = Color.FromArgb(0xFF, 0xA1, 0xA1, 0xAA);   // 弱文字
    static readonly Color CTrack = Color.FromArgb(0xFF, 0xE4, 0xE4, 0xE7);   // 轨道/描边
    static readonly Color CBody = Color.FromArgb(0xFF, 0x52, 0x52, 0x5B);    // 正文

    string installDir = Program.DefaultInstallDir;

    /// <summary>高 DPI 缩放因子（96DPI 基线），布局常量与自绘 paint 用；
    /// 注意 .NET 的 DeviceDpi 在部分环境返回虚拟化值（96），与 GDI 实际渲染 DPI 不一致，
    /// 必须经 Win32 GetDpiForWindow 查询真实 DPI；句柄创建前固定 1（基线布局，避免双重缩放）</summary>
    float S { get { return UiDpi.Of(this) / 96f; } }

    Panel titleBar, pageWelcome, pageProgress, pageDone, pageLaunch, sidebar;
    SidebarPanel steps;
    CheckListPanel checklist;
    Label headerName, headerSlogan, progressHint, progressPercent, pathValue;
    LogoPictureBox headerIcon, launchIcon;
    RoundedButton mainButton, launchButton;
    ProgressBarPanel progressBar, launchBar;
    AgreeCheck agreeBox, desktopBox;
    System.Windows.Forms.Timer launchTimer;
    int launchProgress;
    bool appStarted;
    string zipFile;
    BackgroundWork worker;

    public static int Run()
    {
        Application.Run(new InstallerForm());
        return 0;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int round = 2; // DWMWCP_ROUND：窗口四角圆角
        NativeMethods.DwmSetWindowAttribute(Handle, 33, ref round, 4);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // 高 DPI：实测部分环境下 WinForms AutoScale 不生效（窗口仍停留在 96DPI 基线尺寸 900x580），
        // 此时手动等比缩放整窗与全部子控件（pt 制字体已随 DPI 自动放大，无需处理）
        float f = UiDpi.Of(this) / 96f;
        if (f != 1f && ClientSize.Width == 900)
        {
            Scale(new SizeF(f, f));
        }
        // 缩放完成后按实际 DPI 重排一次（构造期按 96DPI 基线布局，避免与缩放叠加双重放大）
        LayoutWelcome();
        LayoutProgress();
        LayoutDone();
        LayoutLaunch();
    }

    public InstallerForm()
    {
        Text = Program.AppName + " 安装";
        FormBorderStyle = FormBorderStyle.None;
        MinimizeBox = MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        // 高 DPI：整窗与控件按 DPI 等比缩放（pt 制文字会自动放大，坐标必须同步放大）
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(900, 580);
        BackColor = CPage;
        DoubleBuffered = true;

        // ---- 页面（Dock=Fill，先加入让 dock 优先级最低） ----
        pageWelcome = NewPage();
        pageProgress = NewPage();
        pageDone = NewPage();
        pageLaunch = NewPage();
        BuildWelcomePage();
        BuildProgressPage();
        BuildDonePage();
        BuildLaunchPage();

        // ---- 左侧步骤栏（欢迎/进度/完成显示，启动页隐藏） ----
        steps = new SidebarPanel();
        steps.MouseDown += DragWindow;

        // ---- 顶部拖动条 + 右上角操作按钮（透明，不占视觉） ----
        titleBar = new Panel { Height = 40, BackColor = Color.Transparent };
        titleBar.MouseDown += DragWindow;
        titleBar.Controls.Add(MakeCaptionButton("min", (s, e) => WindowState = FormWindowState.Minimized));
        titleBar.Controls.Add(MakeCaptionButton("close", (s, e) => Close()));

        Controls.Add(pageWelcome);
        Controls.Add(pageProgress);
        Controls.Add(pageDone);
        Controls.Add(pageLaunch);
        Controls.Add(steps);
        Controls.Add(titleBar); // 最后加入 → dock 最优先（顶部条不遮侧栏）

        AcceptButton = (IButtonControl)mainButton;
        ShowPage(pageWelcome);
    }

    Panel NewPage()
    {
        var p = new Panel { Dock = DockStyle.Fill, BackColor = CPage };
        p.MouseDown += DragWindow;
        return p;
    }

    void ShowPage(Control page)
    {
        pageWelcome.Visible = page == pageWelcome;
        pageProgress.Visible = page == pageProgress;
        pageDone.Visible = page == pageDone;
        pageLaunch.Visible = page == pageLaunch;
        steps.Visible = page != pageLaunch; // 启动页为全宽 splash
        if (page == pageDone) steps.SetStep(1);
        else if (page == pageLaunch) steps.SetStep(2);
        else steps.SetStep(0);
        AcceptButton = page == pageWelcome ? (IButtonControl)mainButton : null;
    }

    /* ---------- 欢迎页 ---------- */

    Label welcomeName, welcomeSlogan, versionLabel;
    LogoPictureBox welcomeIcon;
    Label agreeText, agreeSep;
    LinkLabel licenseLinkA, licenseLinkB;

    void BuildWelcomePage()
    {
        welcomeIcon = new LogoPictureBox { Size = new Size(76, 76), BackColor = Color.Transparent };
        welcomeName = MakeLabel(Program.AppName, 24f, CInk, true, "Segoe UI");
        welcomeSlogan = MakeLabel("AI 工作流画布 · 一键创作你的灵感", 10.5f, CMuted, false, null);
        mainButton = new RoundedButton
        {
            Text = "立即安装",
            Size = new Size(320, 54),
            Font = new Font("Microsoft YaHei UI", 11.5f, FontStyle.Bold),
        };
        mainButton.Click += OnInstallClick;

        // 协议勾选行：☑ 我已阅读并同意 用户协议 ｜ 隐私政策
        agreeBox = new AgreeCheck();
        agreeText = MakeLabel("我已阅读并同意", 9.5f, CBody, false, null);
        agreeSep = MakeLabel("｜", 9.5f, CTrack, false, null);
        licenseLinkA = MakeLicenseLink("用户协议");
        licenseLinkB = MakeLicenseLink("隐私政策");
        versionLabel = MakeLabel("版本 " + Program.AppVersion + "  ·  Windows 10/11", 9f, CFaint, false, null);

        pageWelcome.Controls.Add(welcomeIcon);
        pageWelcome.Controls.Add(welcomeName);
        pageWelcome.Controls.Add(welcomeSlogan);
        pageWelcome.Controls.Add(mainButton);
        pageWelcome.Controls.Add(agreeBox);
        pageWelcome.Controls.Add(agreeText);
        pageWelcome.Controls.Add(licenseLinkA);
        pageWelcome.Controls.Add(agreeSep);
        pageWelcome.Controls.Add(licenseLinkB);
        pageWelcome.Controls.Add(versionLabel);
        pageWelcome.Controls.Add(new SparkleDecor { Size = new Size(56, 56) });
        pageWelcome.Resize += (s, e) => LayoutWelcome();
        LayoutWelcome();
    }

    LinkLabel MakeLicenseLink(string text)
    {
        var l = new LinkLabel
        {
            Text = text,
            LinkColor = CBody,
            ActiveLinkColor = CInk,
            LinkBehavior = LinkBehavior.AlwaysUnderline,
            Font = new Font("Microsoft YaHei UI", 9.5f),
            AutoSize = true,
            BackColor = Color.Transparent,
        };
        l.Click += ShowLicense;
        return l;
    }

    void LayoutWelcome()
    {
        float s = S;
        int w = pageWelcome.Width, h = pageWelcome.Height, cx = w / 2;
        int blockH = welcomeIcon.Height + (int)(18 * s) + welcomeName.Height + (int)(10 * s) + welcomeSlogan.Height + (int)(36 * s) + mainButton.Height;
        int top = Math.Max((int)(48 * s), (h - (int)(96 * s) - blockH) / 2); // 上方留出标题条，下方给协议行
        welcomeIcon.Location = new Point(cx - welcomeIcon.Width / 2, top);
        welcomeName.Location = new Point(cx - welcomeName.Width / 2, welcomeIcon.Bottom + (int)(18 * s));
        welcomeSlogan.Location = new Point(cx - welcomeSlogan.Width / 2, welcomeName.Bottom + (int)(10 * s));
        mainButton.Location = new Point(cx - mainButton.Width / 2, welcomeSlogan.Bottom + (int)(36 * s));

        // 协议勾选行：内容排成一横排后整体居中，放在主按钮下方
        int x = 0;
        agreeBox.Location = new Point(x, 0);
        x += agreeBox.Width + (int)(8 * s);
        agreeText.Location = new Point(x, (agreeBox.Height - agreeText.Height) / 2);
        x += agreeText.Width + (int)(6 * s);
        licenseLinkA.Location = new Point(x, (agreeBox.Height - licenseLinkA.Height) / 2);
        x += licenseLinkA.Width + (int)(6 * s);
        agreeSep.Location = new Point(x, (agreeBox.Height - agreeSep.Height) / 2);
        x += agreeSep.Width + (int)(6 * s);
        licenseLinkB.Location = new Point(x, (agreeBox.Height - licenseLinkB.Height) / 2);
        x += licenseLinkB.Width;
        ShiftAgreeRow(cx - x / 2, mainButton.Bottom + (int)(30 * s));

        // 版本号贴内容区左下，装饰星贴右下
        versionLabel.Location = new Point((int)(36 * s), h - versionLabel.Height - (int)(20 * s));
        var sparkle = pageWelcome.Controls[pageWelcome.Controls.Count - 1];
        sparkle.Location = new Point(w - sparkle.Width - (int)(32 * s), h - sparkle.Height - (int)(36 * s));
    }

    void ShiftAgreeRow(int left, int top)
    {
        int dx = left - agreeBox.Left, dy = top - agreeBox.Top;
        agreeBox.Left += dx; agreeBox.Top += dy;
        agreeText.Left += dx; agreeText.Top += dy;
        licenseLinkA.Left += dx; licenseLinkA.Top += dy;
        agreeSep.Left += dx; agreeSep.Top += dy;
        licenseLinkB.Left += dx; licenseLinkB.Top += dy;
    }

    /* ---------- 进度页 ---------- */

    Label installTitle, pathCaption;
    FolderIconButton folderBtn;

    void BuildProgressPage()
    {
        headerIcon = new LogoPictureBox { Size = new Size(84, 84), BackColor = Color.Transparent };
        headerName = MakeLabel(Program.AppName, 21f, CInk, true, "Segoe UI");
        headerSlogan = MakeLabel("AI 工作流画布 · 一键创作你的灵感", 11f, CMuted, false, null);
        installTitle = MakeLabel("正在安装...", 15f, CInk, true, null);
        progressHint = MakeLabel("准备安装 …", 10f, CMuted, false, null);
        progressBar = new ProgressBarPanel { Size = new Size(552, 8) };
        progressPercent = MakeLabel("0%", 10f, CBody, false, null);
        checklist = new CheckListPanel { Size = new Size(360, 118), BackColor = Color.Transparent };

        pathCaption = MakeLabel("安装位置", 9.5f, CMuted, false, null);
        pathValue = MakeLabel(installDir, 9.5f, CBody, false, null);
        folderBtn = new FolderIconButton { Size = new Size(26, 26) };
        folderBtn.Click += OnPickFolder;

        pageProgress.Controls.Add(headerIcon);
        pageProgress.Controls.Add(headerName);
        pageProgress.Controls.Add(headerSlogan);
        pageProgress.Controls.Add(installTitle);
        pageProgress.Controls.Add(progressHint);
        pageProgress.Controls.Add(progressBar);
        pageProgress.Controls.Add(progressPercent);
        pageProgress.Controls.Add(checklist);
        pageProgress.Controls.Add(pathCaption);
        pageProgress.Controls.Add(pathValue);
        pageProgress.Controls.Add(folderBtn);
        pageProgress.Resize += (s, e) => LayoutProgress();
        LayoutProgress();
    }

    void LayoutProgress()
    {
        float s = S;
        int w = pageProgress.Width, h = pageProgress.Height, pad = (int)(48 * s);
        headerIcon.Location = new Point(pad, (int)(44 * s));
        headerName.Location = new Point(headerIcon.Right + (int)(24 * s), (int)(52 * s));
        headerSlogan.Location = new Point(headerName.Left, headerName.Bottom + (int)(10 * s));

        installTitle.Location = new Point(pad, headerIcon.Bottom + (int)(44 * s));
        progressHint.Location = new Point(pad, installTitle.Bottom + (int)(12 * s));
        int barW = Math.Min((int)(552 * s), w - pad * 2 - (int)(64 * s));
        progressBar.Size = new Size(barW, (int)(8 * s));
        progressBar.Location = new Point(pad, progressHint.Bottom + (int)(24 * s));
        progressPercent.Location = new Point(progressBar.Right + (int)(14 * s), progressBar.Top - (int)(6 * s));
        checklist.Size = new Size((int)(360 * s), (int)(118 * s));
        checklist.Location = new Point(pad, progressBar.Bottom + (int)(34 * s));

        pathCaption.Location = new Point(pad, h - (int)(48 * s));
        pathValue.Location = new Point(pad + (int)(76 * s), h - (int)(48 * s));
        folderBtn.Location = new Point(Math.Min(pathValue.Right + (int)(14 * s), w - (int)(60 * s)), h - (int)(55 * s));
    }

    void OnPickFolder(object sender, EventArgs e)
    {
        using (var dlg = new FolderBrowserDialog
        {
            SelectedPath = installDir,
            Description = "选择 " + Program.AppName + " 安装位置",
            ShowNewFolderButton = true,
        })
        {
            if (dlg.ShowDialog(this) == DialogResult.OK)
            {
                installDir = dlg.SelectedPath;
                pathValue.Text = installDir;
                LayoutProgress();
            }
        }
    }

    /* ---------- 完成页 ---------- */

    Label doneTitle, doneSub;
    OrbitDecor doneDecor;
    CheckCircle doneMark;

    void BuildDonePage()
    {
        doneDecor = new OrbitDecor { Size = new Size(190, 190), BackColor = Color.Transparent };
        doneMark = new CheckCircle { Size = new Size(96, 96), BackColor = Color.Transparent };
        doneTitle = MakeLabel("安装完成", 22f, CInk, true, null);
        doneSub = MakeLabel(Program.AppName + " 已成功安装到你的电脑", 11f, CMuted, false, null);
        launchButton = new RoundedButton
        {
            Text = "立即启动",
            Size = new Size(320, 54),
            Font = new Font("Microsoft YaHei UI", 11.5f, FontStyle.Bold),
        };
        launchButton.Click += OnLaunchClick;
        desktopBox = new AgreeCheck();
        var desktopText = MakeLabel("创建桌面快捷方式", 10f, CBody, false, null);
        desktopText.Name = "desktopText";

        pageDone.Controls.Add(doneDecor);
        pageDone.Controls.Add(doneMark);
        pageDone.Controls.Add(doneTitle);
        pageDone.Controls.Add(doneSub);
        pageDone.Controls.Add(launchButton);
        pageDone.Controls.Add(desktopBox);
        pageDone.Controls.Add(desktopText);
        pageDone.Controls.Add(new SparkleDecor { Size = new Size(56, 56) });
        doneMark.BringToFront(); // 对勾圆标置于轨道装饰之上：透明装饰的背景擦除会遮住 z 序在其后的同级控件
        pageDone.Resize += (s, e) => LayoutDone();
        LayoutDone();
    }

    void LayoutDone()
    {
        float s = S;
        int w = pageDone.Width, h = pageDone.Height, cx = w / 2;
        var desktopText = (Label)pageDone.Controls.Find("desktopText", true)[0];
        int blockH = doneDecor.Height + (int)(10 * s) + doneTitle.Height + (int)(12 * s) + doneSub.Height + (int)(40 * s) +
                     launchButton.Height + (int)(30 * s) + desktopBox.Height;
        int top = Math.Max((int)(30 * s), (h - blockH) / 2 - (int)(10 * s));
        doneDecor.Location = new Point(cx - doneDecor.Width / 2, top);
        doneMark.Location = new Point(cx - doneMark.Width / 2, top + (doneDecor.Height - doneMark.Height) / 2);
        doneTitle.Location = new Point(cx - doneTitle.Width / 2, doneDecor.Bottom + (int)(10 * s));
        doneSub.Location = new Point(cx - doneSub.Width / 2, doneTitle.Bottom + (int)(12 * s));
        launchButton.Location = new Point(cx - launchButton.Width / 2, doneSub.Bottom + (int)(40 * s));
        int rowW = desktopBox.Width + (int)(8 * s) + desktopText.Width;
        int rowLeft = cx - rowW / 2;
        desktopBox.Location = new Point(rowLeft, launchButton.Bottom + (int)(30 * s));
        desktopText.Location = new Point(desktopBox.Right + (int)(8 * s),
            desktopBox.Top + (desktopBox.Height - desktopText.Height) / 2);
        var sparkle = pageDone.Controls[pageDone.Controls.Count - 1];
        sparkle.Location = new Point(w - sparkle.Width - (int)(32 * s), h - sparkle.Height - (int)(36 * s));
    }

    /* ---------- 启动页（全宽 splash） ---------- */

    Label launchName, launchSlogan, launchHint;

    void BuildLaunchPage()
    {
        var headerIcon = new LogoPictureBox { Size = new Size(30, 30), BackColor = Color.Transparent };
        headerIcon.Name = "launchHeaderIcon";
        var headerName = MakeLabel(Program.AppName, 13f, CInk, true, "Segoe UI");
        headerName.Name = "launchHeaderName";
        var decor = new OrbitDecor { Size = new Size(250, 250), BackColor = Color.Transparent };
        decor.Name = "launchDecor";
        launchIcon = new LogoPictureBox { Size = new Size(124, 124), BackColor = Color.Transparent };
        launchName = MakeLabel(Program.AppName, 27f, CInk, true, "Segoe UI");
        launchSlogan = MakeLabel("AI 工作流画布 · 一键创作你的灵感", 10.5f, CMuted, false, null);
        launchBar = new ProgressBarPanel { Size = new Size(340, 8) };
        launchHint = MakeLabel("正在启动...", 9.5f, CFaint, false, null);

        pageLaunch.Controls.Add(headerIcon);
        pageLaunch.Controls.Add(headerName);
        pageLaunch.Controls.Add(decor);
        pageLaunch.Controls.Add(launchIcon);
        pageLaunch.Controls.Add(launchName);
        pageLaunch.Controls.Add(launchSlogan);
        pageLaunch.Controls.Add(launchBar);
        pageLaunch.Controls.Add(launchHint);
        launchIcon.BringToFront(); // 同完成页：应用图标须在轨道装饰之上
        pageLaunch.Resize += (s, e) => LayoutLaunch();
        LayoutLaunch();

        launchTimer = new System.Windows.Forms.Timer { Interval = 30 };
        launchTimer.Tick += (s, e) =>
        {
            launchProgress = Math.Min(100, launchProgress + 3);
            launchBar.Percent = launchProgress;
            if (!appStarted && launchProgress >= 55)
            {
                appStarted = true;
                try { Process.Start(Path.Combine(installDir, "Dra-Agent.exe")); } catch { }
            }
            if (launchProgress >= 100)
            {
                launchTimer.Stop();
                Close();
            }
        };
    }

    void LayoutLaunch()
    {
        float s = S;
        int w = pageLaunch.Width, h = pageLaunch.Height, cx = w / 2;
        var headerIcon = (LogoPictureBox)pageLaunch.Controls.Find("launchHeaderIcon", true)[0];
        var headerName = (Label)pageLaunch.Controls.Find("launchHeaderName", true)[0];
        var decor = (OrbitDecor)pageLaunch.Controls.Find("launchDecor", true)[0];
        headerIcon.Location = new Point((int)(24 * s), (int)(12 * s));
        headerName.Location = new Point((int)(64 * s), ((int)(40 * s) - headerName.Height) / 2 + (int)(4 * s));

        int top = Math.Max((int)(60 * s), (h - decor.Height - (int)(8 * s) - launchName.Height - (int)(12 * s) - launchSlogan.Height - (int)(34 * s) - launchBar.Height - (int)(24 * s) - launchHint.Height) / 2);
        decor.Location = new Point(cx - decor.Width / 2, top);
        launchIcon.Location = new Point(cx - launchIcon.Width / 2, top + (decor.Height - launchIcon.Height) / 2);
        launchName.Location = new Point(cx - launchName.Width / 2, decor.Bottom + (int)(8 * s));
        launchSlogan.Location = new Point(cx - launchSlogan.Width / 2, launchName.Bottom + (int)(12 * s));
        launchBar.Location = new Point(cx - launchBar.Width / 2, launchSlogan.Bottom + (int)(34 * s));
        launchHint.Location = new Point(cx - launchHint.Width / 2, launchBar.Bottom + (int)(20 * s));
    }

    /* ---------- 安装流程 ---------- */

    void OnInstallClick(object sender, EventArgs e)
    {
        if (!agreeBox.Checked)
        {
            MessageBox.Show(this, "请先阅读并同意用户协议", "提示", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        // 点击安装后再选位置：默认 D 盘新建 Dra-Agent 文件夹（目录预建以便对话框选中）
        try { Directory.CreateDirectory(Program.DefaultInstallDir); } catch { }
        using (var dlg = new FolderBrowserDialog
        {
            SelectedPath = Program.DefaultInstallDir,
            Description = "选择 " + Program.AppName + " 安装位置",
            ShowNewFolderButton = true,
        })
        {
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            installDir = dlg.SelectedPath;
            pathValue.Text = installDir;
        }
        mainButton.Enabled = false;
        checklist.Reset();
        progressPercent.Text = "0%";
        progressBar.Percent = 0;
        ShowPage(pageProgress);
        // 旧版静默卸载（NSIS 残留）→ 解压 → 注册/快捷方式，均在工作线程执行，进度回投 UI
        worker = new BackgroundWork(() =>
        {
            Upgrade.RemovePreviousNsisInstall(msg => SetHint(msg));
            SetHint("正在解压文件 …");
            SetCheck(0, 1);
            zipFile = Program.ExtractEmbeddedZipToTemp();
            try
            {
                ExtractAll(zipFile, installDir, p => SetProgress(p));
            }
            finally
            {
                try { File.Delete(zipFile); } catch { }
            }
            SetCheck(0, 2);
            SetHint("正在安装组件 …");
            SetCheck(1, 1);
            Upgrade.WriteUninstallRegistry(installDir);
            Upgrade.CreateStartMenuShortcut(installDir);
            SetCheck(1, 2);
            SetHint("正在配置环境 …");
            SetCheck(2, 1);
            Thread.Sleep(400);
            SetCheck(2, 2);
        },
        () => Invoke((MethodInvoker)OnInstallDone),
        ex => Invoke((MethodInvoker)delegate
        {
            MessageBox.Show(this, "安装失败：" + ex.Message, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            mainButton.Enabled = true;
            ShowPage(pageWelcome);
        }));
        var t = new Thread(worker.Execute);
        t.IsBackground = true;
        t.Start();
    }

    void OnInstallDone()
    {
        mainButton.Enabled = true;
        ShowPage(pageDone);
    }

    void OnLaunchClick(object sender, EventArgs e)
    {
        if (desktopBox.Checked)
        {
            try { Upgrade.CreateDesktopShortcut(installDir); } catch { }
        }
        launchButton.Enabled = false;
        launchProgress = 0;
        appStarted = false;
        launchBar.Percent = 0;
        ShowPage(pageLaunch);
        launchTimer.Start();
    }

    void ExtractAll(string zipPath, string targetDir, Action<int> onProgress)
    {
        Directory.CreateDirectory(targetDir);
        using (var archive = ZipFile.OpenRead(zipPath))
        {
            int total = archive.Entries.Count, done = 0;
            foreach (var entry in archive.Entries)
            {
                string dest = Path.Combine(targetDir, entry.FullName.Replace('/', '\\'));
                if (dest.EndsWith(Path.DirectorySeparatorChar.ToString()) || entry.FullName.EndsWith("/"))
                {
                    Directory.CreateDirectory(dest);
                }
                else
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    if (File.Exists(dest)) File.Delete(dest);
                    entry.ExtractToFile(dest, true);
                }
                done++;
                onProgress((int)(done * 100L / Math.Max(1, total)));
            }
        }
    }

    delegate void UiUpdate();

    void SetProgress(int percent)
    {
        Invoke((MethodInvoker)delegate
        {
            progressBar.Percent = percent;
            progressPercent.Text = percent + "%";
        });
    }

    void SetHint(string msg)
    {
        Invoke((MethodInvoker)delegate { progressHint.Text = msg; });
    }

    void SetCheck(int index, int state)
    {
        Invoke((MethodInvoker)delegate { checklist.SetState(index, state); });
    }

    void ShowLicense(object sender, EventArgs e)
    {
        string text;
        using (var stream = typeof(Program).Assembly.GetManifestResourceStream("DraLicense"))
        {
            using (var reader = new StreamReader(stream))
            {
                text = reader.ReadToEnd();
            }
        }
        using (var dlg = new Form
        {
            Text = "用户协议",
            Size = new Size(680, 560),
            StartPosition = FormStartPosition.CenterParent,
            BackColor = Color.White,
            MaximizeBox = false,
        })
        {
            var box = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Dock = DockStyle.Fill,
                BackColor = Color.White,
                ForeColor = CBody,
                BorderStyle = BorderStyle.None,
                Font = new Font("Microsoft YaHei UI", 9.5f),
                Text = text,
            };
            dlg.Controls.Add(box);
            dlg.ShowDialog(this);
        }
    }

    /** 标题栏右侧按钮（— ×，加大尺寸，悬停变色，关闭红） */
    CaptionButton MakeCaptionButton(string kind, EventHandler onClick)
    {
        var b = new CaptionButton { Kind = kind, Size = new Size(64, 40) };
        b.Left = kind == "close" ? titleBar.Width - 64 : titleBar.Width - 128;
        b.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        b.Click += onClick;
        return b;
    }

    Label MakeLabel(string text, float size, Color color, bool bold, string face)
    {
        return new Label
        {
            Text = text,
            ForeColor = color,
            Font = new Font(face ?? "Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular),
            AutoSize = true,
            BackColor = Color.Transparent,
        };
    }

    void DragWindow(object sender, MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left)
        {
            NativeMethods.ReleaseCapture();
            NativeMethods.SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero);
        }
    }
}

/* ============================= 卸载 ============================= */

static class Uninstall
{
    public static int Run()
    {
        var r = MessageBox.Show("确定要完全移除 " + Program.AppName + " 吗？",
            "卸载 " + Program.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (r != DialogResult.Yes) return 1;
        // 复制自身到 Temp，由副本删除安装目录（自身文件被占用无法删除）
        string tempCopy = Path.Combine(Path.GetTempPath(), "dra-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
        File.Copy(Application.ExecutablePath, tempCopy, true);
        string dir = Path.GetDirectoryName(Application.ExecutablePath);
        Process.Start(tempCopy, "--uninstall-run=" + dir);
        return 0;
    }

    public static int DoDelete(string dir)
    {
        try
        {
            Upgrade.RemoveShortcuts();
            try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(Program.UninstallKey, false); } catch { }
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
        catch (Exception ex)
        {
            MessageBox.Show("卸载出现问题：" + ex.Message, "卸载 " + Program.AppName,
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            try { File.Delete(Application.ExecutablePath); } catch { }
        }
        return 0;
    }
}

/** 升级 / 系统集成（卸载旧 NSIS 版本、注册表、快捷方式） */
static class Upgrade
{
    public static void RemovePreviousNsisInstall(Action<string> log)
    {
        foreach (var root in new[] { Microsoft.Win32.Registry.CurrentUser, Microsoft.Win32.Registry.LocalMachine })
        {
            using (var key = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall"))
            {
                if (key == null) continue;
                foreach (var sub in key.GetSubKeyNames())
                {
                    using (var info = key.OpenSubKey(sub))
                    {
                        var displayName = info == null ? null : info.GetValue("DisplayName") as string;
                        if (!string.Equals(displayName, Program.AppName, StringComparison.OrdinalIgnoreCase)) continue;
                        var uninst = info.GetValue("UninstallString") as string;
                        log("检测到旧版本，正在移除 …");
                        if (!string.IsNullOrEmpty(uninst))
                        {
                            uninst = uninst.Trim('"');
                            if (File.Exists(uninst))
                            {
                                try
                                {
                                    Process.Start(new ProcessStartInfo(uninst, "/S _?=" + uninst) { UseShellExecute = false });
                                }
                                catch { }
                            }
                        }
                        // NSIS 卸载器立即返回，等待安装目录消失（最多 30s）
                        var sw = Stopwatch.StartNew();
                        while (sw.ElapsedMilliseconds < 30000)
                        {
                            var loc = info.GetValue("InstallLocation") as string;
                            if (string.IsNullOrEmpty(loc) || !Directory.Exists(loc)) break;
                            Thread.Sleep(500);
                        }
                    }
                }
            }
        }
    }

    public static void WriteUninstallRegistry(string dir)
    {
        using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(Program.UninstallKey))
        {
            k.SetValue("DisplayName", Program.AppName);
            k.SetValue("DisplayVersion", Program.AppVersion);
            k.SetValue("DisplayIcon", Path.Combine(dir, "Dra-Agent.exe"));
            k.SetValue("InstallLocation", dir);
            k.SetValue("UninstallString", Path.Combine(dir, "Uninstall " + Program.AppName + ".exe"));
            k.SetValue("Publisher", "MIYOKIGames");
            k.SetValue("NoModify", 1, Microsoft.Win32.RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, Microsoft.Win32.RegistryValueKind.DWord);
        }
        // 卸载器 = 主引导器副本（文件名以 Uninstall 开头即进入卸载模式）
        string self = Application.ExecutablePath;
        string target = Path.Combine(dir, "Uninstall " + Program.AppName + ".exe");
        File.Copy(self, target, true);
    }

    public static void CreateDesktopShortcut(string dir)
    {
        var exe = Path.Combine(dir, "Dra-Agent.exe");
        MakeShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Program.AppName + ".lnk"), exe, dir);
    }

    public static void CreateStartMenuShortcut(string dir)
    {
        var exe = Path.Combine(dir, "Dra-Agent.exe");
        var startMenu = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Programs), Program.AppName);
        Directory.CreateDirectory(startMenu);
        MakeShortcut(Path.Combine(startMenu, Program.AppName + ".lnk"), exe, dir);
    }

    static void MakeShortcut(string lnkPath, string target, string workDir)
    {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        var shortcut = shell.CreateShortcut(lnkPath);
        shortcut.TargetPath = target;
        shortcut.WorkingDirectory = workDir;
        shortcut.Description = Program.AppName + " — AI Agent 画布工作台";
        shortcut.Save();
    }

    public static void RemoveShortcuts()
    {
        try { File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), Program.AppName + ".lnk")); } catch { }
        try
        {
            var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), Program.AppName);
            if (Directory.Exists(startMenu)) Directory.Delete(startMenu, true);
        }
        catch { }
    }
}

/** 后台任务包装：成功 / 失败回投 UI 线程 */
class BackgroundWork
{
    readonly Action body, onSuccess;
    readonly Action<Exception> onFailure;

    public BackgroundWork(Action body, Action onSuccess, Action<Exception> onFailure)
    {
        this.body = body; this.onSuccess = onSuccess; this.onFailure = onFailure;
    }

    public void Execute()
    {
        try { body(); onSuccess(); }
        catch (Exception ex) { onFailure(ex); }
    }
}

/* ============================= 自绘控件 ============================= */

/** 常用绘制：圆角矩形 / 四角星 */
static class Gfx
{
    public static GraphicsPath RoundedRect(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        float d = radius * 2;
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    /** 四角星（logo 同款形状） */
    public static void DrawStar(Graphics g, float cx, float cy, float r, Color color)
    {
        var pts = new[]
        {
            new PointF(cx, cy - r),
            new PointF(cx + r * 0.34f, cy - r * 0.34f),
            new PointF(cx + r, cy),
            new PointF(cx + r * 0.34f, cy + r * 0.34f),
            new PointF(cx, cy + r),
            new PointF(cx - r * 0.34f, cy + r * 0.34f),
            new PointF(cx - r, cy),
            new PointF(cx - r * 0.34f, cy - r * 0.34f),
        };
        using (var brush = new SolidBrush(color))
            g.FillPolygon(brush, pts);
    }

    /** 对勾折线 */
    public static void DrawCheck(Graphics g, RectangleF box, Color color, float width)
    {
        using (var pen = new Pen(color, width) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
            g.DrawLines(pen, new[]
            {
                new PointF(box.X + box.Width * 0.28f, box.Y + box.Height * 0.52f),
                new PointF(box.X + box.Width * 0.44f, box.Y + box.Height * 0.68f),
                new PointF(box.X + box.Width * 0.74f, box.Y + box.Height * 0.34f),
            });
    }
}

/** 主按钮：黑色胶囊，白字（悬停提亮，禁用灰） */
class RoundedButton : Control, IButtonControl
{
    bool hover;

    public RoundedButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.UserPaint | ControlStyles.ResizeRedraw |
                 ControlStyles.SupportsTransparentBackColor, true);
        Cursor = Cursors.Hand;
        // 透明背景让默认 OnPaintBackground 画父级底色，圆角外区域才能透出页面底色
        BackColor = Color.Transparent;
    }

    // 实现 IButtonControl 以支持 Form.AcceptButton（回车触发主按钮）
    public DialogResult DialogResult { get; set; }
    public void NotifyDefault(bool value) { }
    public void PerformClick() { OnClick(EventArgs.Empty); }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = Gfx.RoundedRect(new RectangleF(0, 0, Width - 1, Height - 1), Height / 2f))
        {
            var back = Enabled ? (hover ? Color.FromArgb(0xFF, 0x3F, 0x3F, 0x46) : Color.FromArgb(0xFF, 0x18, 0x18, 0x1B))
                               : Color.FromArgb(0xFF, 0xE4, 0xE4, 0xE7);
            using (var brush = new SolidBrush(back)) e.Graphics.FillPath(brush, path);
            var fore = Enabled ? Color.White : Color.FromArgb(0xFF, 0xA1, 0xA1, 0xAA);
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, fore,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }
}

/** 进度条：圆角轨道 + 黑色填充（Percent 变化自动重绘；圆角外透出页面底色） */
class ProgressBarPanel : Panel
{
    static readonly Color TrackColor = Color.FromArgb(0xFF, 0xE4, 0xE4, 0xE7);
    int percent;

    public ProgressBarPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint |
                 ControlStyles.SupportsTransparentBackColor | ControlStyles.ResizeRedraw, true);
        // 透明背景：默认 OnPaintBackground 会用轨道色填满矩形，把圆角弧线外的四角也涂成轨道色，视觉上变直角
        BackColor = Color.Transparent;
    }

    public int Percent { get { return percent; } set { percent = value; Invalidate(); } }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        float radius = Height / 2f;
        using (var bg = new SolidBrush(TrackColor))
            e.Graphics.FillPath(bg, Gfx.RoundedRect(ClientRectangle, radius));
        int w = (int)(Width * Math.Min(100, percent) / 100.0);
        if (w > 0)
        {
            using (var fg = new SolidBrush(Color.FromArgb(0xFF, 0x18, 0x18, 0x1B)))
                e.Graphics.FillPath(fg, Gfx.RoundedRect(new RectangleF(0, 0, Math.Max(w, Height), Height), radius));
        }
    }
}

/** 嵌入资源 logo（黑圆角方块 + 白四角星） */
class LogoPictureBox : PictureBox
{
    public LogoPictureBox()
    {
        SizeMode = PictureBoxSizeMode.Zoom;
        Image = Program.LoadLogo();
    }
}

/** 完成页对勾圆标：黑色实心圆 + 白色对勾 */
class CheckCircle : Control
{
    public CheckCircle()
    {
        // 基类 Control 默认不支持透明背景色（A<255 赋值会抛 ArgumentException），显式开启
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint |
                 ControlStyles.SupportsTransparentBackColor, true);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var brush = new SolidBrush(Color.FromArgb(0xFF, 0x18, 0x18, 0x1B)))
            e.Graphics.FillEllipse(brush, 0, 0, Width - 1, Height - 1);
        Gfx.DrawCheck(e.Graphics, new RectangleF(0, 0, Width, Height), Color.White, Width * 0.07f);
    }
}

/** 轨道装饰：细椭圆环 + 散布四角星（完成页/启动页背景点缀） */
class OrbitDecor : Control
{
    public OrbitDecor()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint |
                 ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        float s = UiDpi.Of(this) / 96f;
        float cx = Width / 2f, cy = Height / 2f;
        using (var pen = new Pen(Color.FromArgb(0xFF, 0xEC, 0xEC, 0xEE), 1.2f * s))
        {
            e.Graphics.DrawEllipse(pen, cx - Width * 0.46f, cy - Height * 0.34f, Width * 0.92f, Height * 0.68f);
            e.Graphics.DrawEllipse(pen, cx - Width * 0.34f, cy - Height * 0.42f, Width * 0.68f, Height * 0.84f);
        }
        Gfx.DrawStar(e.Graphics, cx + Width * 0.40f, cy - Height * 0.30f, 7f * s, Color.FromArgb(0xFF, 0xC9, 0xC9, 0xCE));
        Gfx.DrawStar(e.Graphics, cx - Width * 0.42f, cy + Height * 0.22f, 5f * s, Color.FromArgb(0xFF, 0xD9, 0xD9, 0xDD));
        Gfx.DrawStar(e.Graphics, cx + Width * 0.28f, cy + Height * 0.40f, 4f * s, Color.FromArgb(0xFF, 0xE4, 0xE4, 0xE7));
    }
}

/** 页面角落装饰星 */
class SparkleDecor : Control
{
    public SparkleDecor()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint |
                 ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        float s = UiDpi.Of(this) / 96f;
        Gfx.DrawStar(e.Graphics, Width * 0.62f, Height * 0.34f, 10f * s, Color.FromArgb(0xFF, 0xC9, 0xC9, 0xCE));
        Gfx.DrawStar(e.Graphics, Width * 0.25f, Height * 0.72f, 5f * s, Color.FromArgb(0xFF, 0xE0, 0xE0, 0xE3));
    }
}

/** 方形勾选框：选中黑底白勾（替代系统 CheckBox 视觉） */
class AgreeCheck : Control
{
    public bool Checked { get; set; }

    public AgreeCheck()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint |
                 ControlStyles.SupportsTransparentBackColor | ControlStyles.ResizeRedraw, true);
        Cursor = Cursors.Hand;
        BackColor = Color.Transparent;
        Size = new Size(18, 18);
        Checked = true;
    }

    protected override void OnClick(EventArgs e)
    {
        Checked = !Checked;
        Invalidate();
        base.OnClick(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        float s = UiDpi.Of(this) / 96f;
        var r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
        if (Checked)
        {
            using (var brush = new SolidBrush(Color.FromArgb(0xFF, 0x18, 0x18, 0x1B)))
                e.Graphics.FillPath(brush, Gfx.RoundedRect(r, 4.5f * s));
            Gfx.DrawCheck(e.Graphics, new RectangleF(0, 0, Width, Height), Color.White, 1.9f * s);
        }
        else
        {
            using (var brush = new SolidBrush(Color.White))
                e.Graphics.FillPath(brush, Gfx.RoundedRect(r, 4.5f * s));
            using (var pen = new Pen(Color.FromArgb(0xFF, 0xC9, 0xC9, 0xCE), 1.4f * s))
                e.Graphics.DrawPath(pen, Gfx.RoundedRect(r, 4.5f * s));
        }
    }
}

/** 三步安装清单（解压文件/安装组件/配置环境）：0 待处理 1 进行中 2 完成 */
class CheckListPanel : Control
{
    readonly string[] items = { "解压文件", "安装组件", "配置环境" };
    readonly int[] states = { 0, 0, 0 };

    public CheckListPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint |
                 ControlStyles.SupportsTransparentBackColor | ControlStyles.ResizeRedraw, true);
        BackColor = Color.Transparent;
    }

    public void SetState(int index, int state)
    {
        states[index] = state;
        Invalidate();
    }

    public void Reset()
    {
        for (int i = 0; i < states.Length; i++) states[i] = 0;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        float s = UiDpi.Of(this) / 96f;
        int rowH = (int)(40 * s);
        for (int i = 0; i < items.Length; i++)
        {
            int y = i * rowH;
            var circle = new RectangleF(1, y + 1, 20 * s, 20 * s);
            if (states[i] > 0)
            {
                using (var brush = new SolidBrush(Color.FromArgb(0xFF, 0x18, 0x18, 0x1B)))
                    e.Graphics.FillEllipse(brush, circle);
                Gfx.DrawCheck(e.Graphics, circle, Color.White, 1.8f * s);
            }
            else
            {
                using (var pen = new Pen(Color.FromArgb(0xFF, 0xD4, 0xD4, 0xD8), 1.4f * s))
                    e.Graphics.DrawEllipse(pen, circle);
                Gfx.DrawCheck(e.Graphics, circle, Color.FromArgb(0xFF, 0xD4, 0xD4, 0xD8), 1.6f * s);
            }
            TextRenderer.DrawText(e.Graphics, items[i], new Font("Microsoft YaHei UI", 11f),
                new Rectangle((int)(34 * s), y, Width - (int)(34 * s), (int)(22 * s)),
                states[i] > 0 ? Color.FromArgb(0xFF, 0x3F, 0x3F, 0x46) : Color.FromArgb(0xFF, 0xA1, 0xA1, 0xAA),
                TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
        }
    }
}

/** 左侧步骤栏：logo + 名称 + 安装/完成/启动步骤（虚线连接，当前步黑点） */
class SidebarPanel : Control
{
    readonly string[] items = { "安装", "完成", "启动" };
    int active;

    public SidebarPanel()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint |
                 ControlStyles.ResizeRedraw, true);
        Dock = DockStyle.Left;
        Width = 200;
        BackColor = Color.FromArgb(0xFF, 0xFA, 0xFA, 0xFB);
    }

    public void SetStep(int step)
    {
        active = step;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        // 侧栏底 + 右缘细分隔线
        using (var bg = new SolidBrush(BackColor))
            e.Graphics.FillRectangle(bg, ClientRectangle);
        using (var pen = new Pen(Color.FromArgb(0xFF, 0xEC, 0xEC, 0xEE), 1f))
            e.Graphics.DrawLine(pen, Width - 1, 0, Width - 1, Height);

        float s = UiDpi.Of(this) / 96f;
        // logo + 名称
        var logo = Program.LoadLogo();
        e.Graphics.DrawImage(logo, new Rectangle((int)(24 * s), (int)(24 * s), (int)(38 * s), (int)(38 * s)));
        TextRenderer.DrawText(e.Graphics, Program.AppName,
            new Font("Segoe UI", 13.5f, FontStyle.Bold),
            new Point((int)(24 * s), (int)(72 * s)), Color.FromArgb(0xFF, 0x18, 0x18, 0x1B),
            TextFormatFlags.NoPadding);

        // 步骤：圆点 + 虚线连接 + 文字
        int y0 = (int)(158 * s), gap = (int)(58 * s), dotX = (int)(33 * s), dotR = (int)(6 * s);
        var font = new Font("Microsoft YaHei UI", 12f);
        for (int i = 0; i < items.Length; i++)
        {
            int cy = y0 + i * gap;
            if (i > 0)
            {
                using (var dash = new Pen(Color.FromArgb(0xFF, 0xD9, 0xD9, 0xDD), 1.2f * s))
                {
                    dash.DashStyle = DashStyle.Dash;
                    e.Graphics.DrawLine(dash, dotX, cy - gap + dotR + (int)(5 * s), dotX, cy - dotR - (int)(5 * s));
                }
            }
            var color = i == active ? Color.FromArgb(0xFF, 0x18, 0x18, 0x1B)
                : i < active ? Color.FromArgb(0xFF, 0xD4, 0xD4, 0xD8)
                : Color.FromArgb(0xFF, 0xE4, 0xE4, 0xE7);
            using (var brush = new SolidBrush(color))
                e.Graphics.FillEllipse(brush, dotX - dotR, cy - dotR, dotR * 2, dotR * 2);
            TextRenderer.DrawText(e.Graphics, items[i], font,
                new Point(dotX + (int)(18 * s), cy - (int)(10 * s)),
                i == active ? Color.FromArgb(0xFF, 0x18, 0x18, 0x1B) : Color.FromArgb(0xFF, 0xA1, 0xA1, 0xAA),
                TextFormatFlags.NoPadding);
        }
    }
}

/** 文件夹小图标按钮（进度页安装位置行尾，点击更换目录） */
class FolderIconButton : Control
{
    bool hover;

    public FolderIconButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint |
                 ControlStyles.SupportsTransparentBackColor | ControlStyles.ResizeRedraw, true);
        Cursor = Cursors.Hand;
        BackColor = Color.Transparent;
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        var color = hover ? Color.FromArgb(0xFF, 0x18, 0x18, 0x1B) : Color.FromArgb(0xFF, 0x71, 0x71, 0x7A);
        float s = UiDpi.Of(this) / 96f;
        float x = Width * 0.12f, y = Height * 0.2f, w = Width * 0.76f, h = Height * 0.6f, tab = w * 0.38f, r = 3f * s;
        // 路径：左上小折耳 + 圆角矩形主体
        using (var path = new GraphicsPath())
        {
            path.AddArc(x, y, r * 2, r * 2, 180, 90);
            path.AddLine(x + r, y, x + tab - r, y);
            path.AddArc(x + tab - r * 2, y, r * 2, r * 2, 270, 90);
            path.AddLine(x + tab, y + r, x + tab + 3, y + r * 2.2f);
            path.AddLine(x + w - r * 2, y + r * 2.2f, x + w - r * 2, y + r * 2.2f);
            path.AddArc(x + w - r * 2, y + r * 2.2f, r * 2, r * 2, 270, 90);
            path.AddLine(x + w, y + r * 2.2f + r, x + w, y + h - r);
            path.AddArc(x + w - r * 2, y + h - r * 2, r * 2, r * 2, 0, 90);
            path.AddLine(x + w - r, y + h, x + r, y + h);
            path.AddArc(x, y + h - r * 2, r * 2, r * 2, 90, 90);
            path.AddLine(x, y + h - r, x, y + r);
            path.CloseFigure();
            using (var pen = new Pen(color, 1.5f * UiDpi.Of(this) / 96f) { LineJoin = LineJoin.Round })
                e.Graphics.DrawPath(pen, path);
        }
    }
}

/** 标题栏按钮：— / ×（悬停浅灰底；关闭悬停红底白勾） */
class CaptionButton : Control
{
    public string Kind { get; set; }
    bool hover;

    public CaptionButton()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.UserPaint | ControlStyles.ResizeRedraw |
                 ControlStyles.SupportsTransparentBackColor, true);
        Cursor = Cursors.Hand;
        BackColor = Color.Transparent;
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        bool isClose = Kind == "close";
        if (hover)
        {
            using (var brush = new SolidBrush(isClose ? Color.FromArgb(0xFF, 0xE8, 0x11, 0x23) : Color.FromArgb(0xFF, 0xF4, 0xF4, 0xF5)))
                e.Graphics.FillRectangle(brush, ClientRectangle);
        }
        var color = hover && isClose ? Color.White : Color.FromArgb(0xFF, 0x52, 0x52, 0x5B);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        // 字形随按钮高度放大（40px 高 → 16px 字形）
        int gs = Math.Max(12, Height * 2 / 5);
        using (var pen = new Pen(color, 1.8f * UiDpi.Of(this) / 96f) { StartCap = LineCap.Round, EndCap = LineCap.Round })
        {
            var c = new Rectangle((Width - gs) / 2, (Height - gs) / 2, gs, gs);
            if (Kind == "min") e.Graphics.DrawLine(pen, c.Left, c.Top + gs / 2, c.Right, c.Top + gs / 2);
            else
            {
                e.Graphics.DrawLine(pen, c.Left, c.Top, c.Right, c.Bottom);
                e.Graphics.DrawLine(pen, c.Right, c.Top, c.Left, c.Bottom);
            }
        }
    }
}

/** 实际 DPI 查询：.NET DeviceDpi 可能返回虚拟化值（96）而 GDI 字体按真实 DPI（如 192）渲染，
 *  两者不一致会导致“文字放大、坐标不变”的布局错乱；统一以 GetDpiForWindow 为准 */
static class UiDpi
{
    public static float Of(Control c)
    {
        if (c != null && c.IsHandleCreated)
        {
            try
            {
                int dpi = NativeMethods.GetDpiForWindow(c.Handle);
                if (dpi > 0) return dpi;
            }
            catch { }
        }
        return 96f;
    }
}

static class NativeMethods
{
    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    public static extern int GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    // Win11 窗口四角圆角（DWMWA_WINDOW_CORNER_PREFERENCE / DWMWCP_ROUND；Win10 返回错误码无害）
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int pref, int size);
}
