// Integration adapted from InPlayerEpisodePreview-TV (MIT); see LICENSE.InPlayerEpisodePreview.md.
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.TvItemLayout;

public sealed class Plugin : BasePlugin<BasePluginConfiguration>
{
    public const string PluginId = "1a06b74f-7609-4af9-899d-430c9b5a52b1";

    public Plugin(
        IApplicationPaths applicationPaths,
        IXmlSerializer xmlSerializer,
        IServerConfigurationManager configurationManager)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        ConfigurationManager = configurationManager;
    }

    public static Plugin Instance { get; private set; } = null!;

    internal IServerConfigurationManager ConfigurationManager { get; }

    public override string Name => "ScreenHarbour Brasil";

    public override Guid Id => Guid.Parse(PluginId);

    public override string Description => "Interface cinematográfica para Jellyfin, com fileiras personalizadas de coleções e serviços de streaming, guia de TV ao vivo e navegação in-player.";
}
