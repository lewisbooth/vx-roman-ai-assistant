const tiles = [
  {
    title: "Measure windows",
    description: "Get it right every time",
    image: "roman-tile-measure-line.png",
    width: 178,
    colour: "roman-tile-measure-colour.png",
  },
  {
    title: "Visualize in room",
    description: "Upload a photo",
    image: "roman-tile-visualize.png",
    width: 76,
  },
  {
    title: "Find your style",
    description: "Upload a mood board",
    image: "roman-tile-style.png",
    width: 100,
  },
  {
    title: "Explore No-Drill",
    description: "Easy fitting, no stress",
    image: "roman-tile-no-drill.png",
    width: 86,
  },
] as const;

export function Welcome({ logoUrl }: { logoUrl: string }) {
  const assetUrl = (name: string) =>
    new URL(name, new URL(logoUrl, window.location.href)).href;

  return (
    <section className="roman-welcome" aria-labelledby="roman-welcome-title">
      <img
        src={logoUrl}
        alt="Roman by SelectBlinds"
        width={121}
        height={50}
        className="roman-welcome-logo"
      />
      <h1 id="roman-welcome-title" className="roman-welcome-title">
        A brighter home <em>starts</em> with a conversation.
      </h1>
      <p className="roman-welcome-question">Where would you like to begin?</p>
      <div className="roman-welcome-tiles">
        {tiles.map((tile) => (
          <button
            key={tile.title}
            type="button"
            disabled
            className="roman-welcome-tile"
            aria-label={`${tile.title} — coming soon`}
            title="Coming soon"
          >
            <span className="roman-tile-art" aria-hidden="true">
              <img
                src={assetUrl(tile.image)}
                alt=""
                width={tile.width}
                height={100}
                className="roman-tile-image"
              />
              {"colour" in tile && (
                <img
                  src={assetUrl(tile.colour)}
                  alt=""
                  width={178}
                  height={100}
                  className="roman-tile-image roman-tile-colour"
                />
              )}
            </span>
            <span className="roman-tile-title">{tile.title}</span>
            <span className="roman-tile-description">{tile.description}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
