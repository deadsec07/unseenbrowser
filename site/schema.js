// Loads JSON-LD schema from external JSON files and injects into <head>
(function loadSchemas() {
  var files = [
    'schema/software.json',
    'schema/organization.json'
  ];

  files.forEach(function (path) {
    fetch(path, { credentials: 'omit' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        var s = document.createElement('script');
        s.type = 'application/ld+json';
        s.text = JSON.stringify(data);
        document.head.appendChild(s);
      })
      .catch(function () { /* ignore */ });
  });
})();

