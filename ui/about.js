/**
 * Copyright 2025 Samuel Frontull and Simon Haller-Seeber, University of Innsbruck
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export async function renderAbout(container, sidebar) {
  try {
    const response = await fetch("ui/html/about.html"); // path to your HTML file
    if (!response.ok) throw new Error("Failed to load About page");

    const html = await response.text();
    container.innerHTML = html;

    const sidebarResponse = await fetch("ui/html/about-sidebar.html");
    if (sidebarResponse.ok) {
      const sidebarHtml = await sidebarResponse.text();
      sidebar.innerHTML = sidebarHtml;
    }

  } catch (err) {
    container.innerHTML = `<p>Error loading About page: ${err.message}</p>`;
    console.error(err);
  }
}
